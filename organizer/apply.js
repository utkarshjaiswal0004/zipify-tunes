// Carrying out an organizer plan (organizer/plan.js) on the person's music,
// one operation at a time, and undoing a run. These are someone's songs, so:
//   - nothing is ever overwritten: copies use COPYFILE_EXCL, a move or rename
//     looks first, and a taken name becomes "<name> (2)", "(3)"…
//   - no song is ever deleted: a move is a rename on the same drive (moving
//     between drives is refused, never done as a copy and a delete), and undo
//     only removes files the run created, once their size matches the journal
//   - every path is resolved (realpath) and must stay inside the scanned
//     folder or the chosen target folder; links are never followed
//   - an operation's journal entry is written before it, and marked done
//     after, so a run cut short by a crash can still be undone
//
// The journal, "<root>/.zipify-organizer/journal-<UTC time>.json", is JSON
// Lines (one JSON object per line): each entry is a small append instead of
// a rewrite of the whole file, and a crash can only cut its last line short.
//   { type: 'header', version: 1, root, action, allowedFolders, startedAt }
//   { type: 'start', i, kind, from?, to, part?, size? }   before operation i
//   { type: 'done', i } | { type: 'failed', i, error }    after it
//   { type: 'end', status, done, failed }                 after the run
//   { type: 'undone', i }                                 added by undo
//
// API (used by organizer/routes.js):
//
//   createJournal({ root, action, allowedFolders, fsImpl = fs.promises,
//       now = Date.now }) -> Promise<{ path, write(record) }>
//     Starts a new journal (never replacing one) with its header line.
//     Rejects when it can't be written: nothing may start without it.
//
//   applyOperations({ operations, root, allowedFolders = [root], journal,
//       fsImpl = fs.promises, onProgress, log }) -> Promise<Result>
//     Carries out the plan's operations in order. A failed operation is
//     reported and the next one tried; the run stops when the journal can't
//     be written, or after 25 failures in a row (the drive is probably gone).
//     onProgress({ done, total, failed, failure? }) after each operation:
//     failed is a count, failure the { operation, error } just added.
//
//   readJournal(journalPath, { fsImpl }) -> Promise<{ header, entries }>
//     entries: [{ i, kind, from?, to, part?, size?, state, isUndone }] by i,
//     state 'pending' (started, never marked: a crash), 'done' or 'failed'.
//     Rejects for a file that isn't a journal, or one damaged before its
//     last line.
//
//   undoJournal({ journal, journalPath, allowedFolders, fsImpl, onProgress,
//       log }) -> Promise<Result>
//     Reverses the journal's entries, newest first, as far as the disk
//     allows: copies and playlists it wrote are removed (size checked),
//     moved and renamed songs put back (never over anything), folders it made
//     removed when empty. Nothing outside allowedFolders is touched, whatever
//     the journal says. Each entry undone is marked, so undoing again (after
//     a crash, say) picks up where it stopped. onProgress as above.
//
//   readableError(err) -> what went wrong, in words for the page
//
//   Result = { status: 'done' | 'error', done, total,
//              failed: [{ operation: { kind, from?, to, songId? }, error }], error? }
//     'error' (with error) when the run had to stop; failed lists the
//     operations that didn't happen, in words for the page.
//
// fsImpl: lstat, realpath, mkdir, rmdir, copyFile, rename, unlink, rm, open,
// writeFile, appendFile and readFile, like fs.promises; tests pass fakes.

const fs = require('fs')
const path = require('path')
const { isInside, pathKey, publicOperation, suffixedFileName, suffixedFolderName } = require('./plan')

const JOURNAL_FOLDER = '.zipify-organizer'
const JOURNAL_VERSION = 1
// journals started in the same millisecond: "-2", "-3"…
const MAX_JOURNALS_AT_ONCE = 1000
const PART_SUFFIX = '.part'
const MAC_TWIN_PREFIX = '._'
// the first four bytes of every AppleDouble ("._") metadata file
const APPLE_DOUBLE_MAGIC = 0x00051607
const MAX_SUFFIX = 9999
// that many failures one after another: the drive was probably pulled out
const MAX_FAILURES_IN_A_ROW = 25
const KINDS = new Set(['mkdir', 'copy', 'move', 'rename', 'write-m3u'])
const SIZED_KINDS = new Set(['copy', 'write-m3u'])
const SONG_KINDS = new Set(['copy', 'move', 'rename'])

// What a drive error means, for the page
const ERROR_WORDS = {
  ENOENT: 'It is not there any more',
  EACCES: 'Permission denied',
  EPERM: 'The drive did not allow it',
  ENOSPC: 'The drive is full',
  EROFS: 'The drive is read-only',
  EIO: 'The drive stopped responding (was it unplugged?)',
  EXDEV: "Can't move between drives: copy instead",
  EEXIST: 'Something with that name is already there',
  ENOTDIR: 'A folder on the way is a file',
  ENOTEMPTY: 'The folder is not empty',
  ENAMETOOLONG: 'The name is too long for the drive',
  EINVAL: 'The drive refused the name'
}

// The journal can't be written: carrying on would leave changes no undo knows
class JournalError extends Error {}

function readableError (err) {
  const words = ERROR_WORDS[err?.code]
  if (words) return `${words} (${err.code})`
  return err instanceof Error ? err.message : String(err)
}

// ---------- the journal ----------

async function createJournal ({ root, action, allowedFolders, fsImpl = fs.promises, now = Date.now }) {
  const folder = path.join(root, JOURNAL_FOLDER)
  await makeJournalFolder(folder, fsImpl)
  const startedAt = new Date(now()).toISOString()
  const header = { type: 'header', version: JOURNAL_VERSION, root, action, allowedFolders, startedAt }
  // FAT32 refuses ":" in names
  const stamp = startedAt.replace(/[:.]/g, '-')
  const journalPath = await writeFirstFree(folder, stamp, `${JSON.stringify(header)}\n`, fsImpl)
  return { path: journalPath, write: (record) => appendRecord(journalPath, record, fsImpl) }
}

// The journal folder must be a real folder in root: a link there could send
// the journal (and its undo) somewhere else
async function makeJournalFolder (folder, fsImpl) {
  try {
    await fsImpl.mkdir(folder)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    if (!(await fsImpl.lstat(folder)).isDirectory()) throw new Error(`${folder} is not a folder`)
  }
}

async function writeFirstFree (folder, stamp, text, fsImpl) {
  for (let n = 1; n <= MAX_JOURNALS_AT_ONCE; n++) {
    const candidate = path.join(folder, `journal-${stamp}${n === 1 ? '' : `-${n}`}.json`)
    try {
      await fsImpl.writeFile(candidate, text, { encoding: 'utf8', flag: 'wx' })
      return candidate
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
  throw new Error(`Too many journals named journal-${stamp} in ${folder}`)
}

async function appendRecord (journalPath, record, fsImpl) {
  try {
    await fsImpl.appendFile(journalPath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (err) {
    throw new JournalError(`Stopped: could not write the undo journal ${journalPath} (${readableError(err)})`)
  }
}

// ---------- paths ----------

// A path from a plan or a journal must be absolute and plain: no "..", no "//"
function isPlainAbsolute (p) {
  return typeof p === 'string' && path.isAbsolute(p) && path.resolve(p) === p
}

function isInsideAny (p, folders) {
  return folders.some((folder) => isInside(p, folder))
}

async function lstatOrNull (p, fsImpl) {
  try {
    return await fsImpl.lstat(p)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// A song to copy or move: a regular file (not a link) inside the scanned
// folder, once every link on the way is resolved
async function checkedSource (from, ctx) {
  if (!isPlainAbsolute(from)) throw new Error('Refused: the song\'s path is not a plain full path')
  const stat = await ctx.fsImpl.lstat(from)
  if (!stat.isFile()) throw new Error('Refused: not a regular file (links are never followed)')
  const real = await ctx.fsImpl.realpath(from)
  if (real === ctx.realRoot || !isInside(real, ctx.realRoot)) throw new Error('Refused: outside the scanned folder')
  return { path: real, size: stat.size, dev: stat.dev, ino: stat.ino }
}

// Where something new goes: its folder resolved (realpath), which must be
// inside an allowed folder, and the name it is to have
async function checkedTarget (to, ctx) {
  const planned = remapped(to, ctx.remaps)
  if (!isPlainAbsolute(planned)) throw new Error('Refused: the target is not a plain full path')
  const parent = await ctx.fsImpl.realpath(path.dirname(planned))
  if (!isInsideAny(parent, ctx.allowed)) throw new Error('Refused: outside the chosen folders')
  return { parent, name: path.basename(planned) }
}

// A fresh folder that had to become "<name> (2)" takes what was planned for
// "<name>" with it
function remapped (p, remaps) {
  return remaps.reduce((current, { from, to }) => {
    if (current === from) return to
    return current.startsWith(`${from}${path.sep}`) ? `${to}${current.slice(from.length)}` : current
  }, p)
}

// "<name>", or "<name> (2)", "(3)"… whichever nothing is using (with
// alsoFree, nothing may use "<candidate><suffix>" either)
async function firstFreePath (ctx, parent, name, { suffixed = suffixedFileName, alsoFree = [] } = {}) {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = path.join(parent, suffixed(name, n))
    const blockers = [candidate, ...alsoFree.map((suffix) => `${candidate}${suffix}`)]
    const taken = await Promise.all(blockers.map((p) => lstatOrNull(p, ctx.fsImpl)))
    if (taken.every((stat) => stat === null)) return candidate
  }
  throw new Error(`Too many files named "${name}" already`)
}

// macOS keeps the metadata a copy carries (it can't store it on FAT32) in a
// "._<name>" twin, which car stereos list as a broken track. A twin of a
// file this run created is junk, but only a file that really is AppleDouble
// metadata is removed: a song could have a name like that. Best-effort.
async function removeMacTwin (filePath, ctx) {
  const twin = path.join(path.dirname(filePath), `${MAC_TWIN_PREFIX}${path.basename(filePath)}`)
  try {
    if (await isAppleDouble(twin, ctx.fsImpl)) await ctx.fsImpl.unlink(twin)
  } catch (err) {
    ctx.log(`Could not remove ${twin}:`, err.message)
  }
}

async function isAppleDouble (filePath, fsImpl) {
  const stat = await lstatOrNull(filePath, fsImpl)
  if (!stat || !stat.isFile()) return false
  const handle = await fsImpl.open(filePath, 'r')
  try {
    const head = Buffer.alloc(4)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return bytesRead === head.length && head.readUInt32BE(0) === APPLE_DOUBLE_MAGIC
  } finally {
    await handle.close()
  }
}

// ---------- carrying out operations ----------

async function applyOperations ({
  operations,
  root,
  allowedFolders = [root],
  journal,
  fsImpl = fs.promises,
  onProgress = () => {},
  log = console.log
}) {
  const total = operations.length
  const failed = []
  let done = 0
  let failuresInARow = 0

  const finish = async (status, error) => {
    await journal
      .write({ type: 'end', status, done, failed: failed.length })
      .catch((err) => log('Could not finish the journal:', err.message))
    return { status, done, total, failed: [...failed], ...(error ? { error } : {}) }
  }

  let ctx
  try {
    const realRoot = await fsImpl.realpath(root)
    const allowed = await Promise.all(allowedFolders.map((folder) => fsImpl.realpath(folder)))
    ctx = { realRoot, allowed: [realRoot, ...allowed], journal, fsImpl, log, remaps: [] }
  } catch (err) {
    return finish('error', `Could not start: ${readableError(err)}`)
  }

  for (const [i, op] of operations.entries()) {
    const outcome = await attempt(op, i, ctx)
    if (outcome.fatal) return finish('error', outcome.fatal)
    const failure = outcome.error ? { operation: publicOperation(op), error: outcome.error } : null
    if (failure) failed.push(failure)
    failuresInARow = failure ? failuresInARow + 1 : 0
    done++
    onProgress({ done, total, failed: failed.length, ...(failure ? { failure } : {}) })
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
      return finish('error', `Stopped after ${MAX_FAILURES_IN_A_ROW} failures in a row. Is the drive still plugged in?`)
    }
  }
  return finish('done')
}

// One operation -> {} | { error } | { fatal }
async function attempt (op, i, ctx) {
  try {
    const run = RUNNERS[op?.kind]
    if (!run) throw new Error(`Unknown operation "${op?.kind}"`)
    await run(op, i, ctx)
    return {}
  } catch (err) {
    if (err instanceof JournalError) return { fatal: err.message }
    const error = readableError(err)
    try {
      await ctx.journal.write({ type: 'failed', i, error })
    } catch (journalErr) {
      return { fatal: journalErr.message }
    }
    return { error }
  }
}

async function runMkdir (op, i, ctx) {
  const { parent, name } = await checkedTarget(op.to, ctx)
  const wanted = path.join(parent, name)
  const there = await lstatOrNull(wanted, ctx.fsImpl)
  if (there && !op.fresh) {
    if (!there.isDirectory()) throw new Error(`"${name}" is a file, not a folder`)
    return // already there: nothing to do, and nothing for undo to remove
  }

  // a playlist's folder must be new: if one appeared since the plan, its
  // songs go into "<name> (2)" instead
  const folder = there ? await firstFreePath(ctx, parent, name, { suffixed: suffixedFolderName }) : wanted
  await ctx.journal.write({ type: 'start', i, kind: 'mkdir', to: folder })
  await ctx.fsImpl.mkdir(folder)
  await ctx.journal.write({ type: 'done', i })
  if (folder !== op.to) ctx.remaps.push({ from: op.to, to: folder })
}

async function runCopy (op, i, ctx) {
  const source = await checkedSource(op.from, ctx)
  const { parent, name } = await checkedTarget(op.to, ctx)
  const to = await firstFreePath(ctx, parent, name, { alsoFree: [PART_SUFFIX] })
  const part = `${to}${PART_SUFFIX}`

  await ctx.journal.write({ type: 'start', i, kind: 'copy', from: source.path, to, part, size: source.size })
  await copyIntoPlace(source, to, part, ctx.fsImpl, ctx.log)
  await ctx.journal.write({ type: 'done', i })
  // the twin may still carry the .part's name if the drive didn't rename it along
  await removeMacTwin(to, ctx)
  await removeMacTwin(part, ctx)
}

// Copy to "<to>.part" first, so a copy cut short never sits under a song's
// name; check its size; then give it its name, still never over anything.
// Any .part this created is removed again if something goes wrong.
async function copyIntoPlace (source, to, part, fsImpl, log) {
  try {
    await fsImpl.copyFile(source.path, part, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    // EEXIST: that .part appeared after the check; it isn't this run's
    if (err.code !== 'EEXIST') await removeOwnFile(part, fsImpl, log)
    throw err
  }

  try {
    const copied = await fsImpl.lstat(part)
    if (copied.size !== source.size) {
      throw new Error(`The copy came out ${copied.size} bytes long instead of ${source.size}`)
    }
    if (await lstatOrNull(to, fsImpl)) throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' })
    await fsImpl.rename(part, to)
  } catch (err) {
    await removeOwnFile(part, fsImpl, log)
    throw err
  }
}

// Remove a half-made file this run created (a .part, a playlist). The error
// the person hears about is the one that made this necessary; a failure here
// is only logged.
async function removeOwnFile (filePath, fsImpl, log) {
  try {
    await fsImpl.rm(filePath, { force: true })
  } catch (err) {
    log(`Could not remove ${filePath}:`, err.message)
  }
}

async function runMove (op, i, ctx) {
  const source = await checkedSource(op.from, ctx)
  const { parent, name } = await checkedTarget(op.to, ctx)
  const wanted = path.join(parent, name)
  if (wanted === source.path) return

  const to = (await isCaseOnlyRename(source, wanted, ctx.fsImpl)) ? wanted : await firstFreePath(ctx, parent, name)
  await ctx.journal.write({ type: 'start', i, kind: op.kind, from: source.path, to, size: source.size })
  await ctx.fsImpl.rename(source.path, to)
  await ctx.journal.write({ type: 'done', i })
}

// "song.mp3" -> "Song.mp3": on a drive that ignores case the new name is
// the song itself, not another file in the way
async function isCaseOnlyRename (source, wanted, fsImpl) {
  if (pathKey(wanted) !== pathKey(source.path)) return false
  const there = await lstatOrNull(wanted, fsImpl)
  return there === null || (there.dev === source.dev && there.ino === source.ino)
}

async function runWritePlaylist (op, i, ctx) {
  if (typeof op.content !== 'string') throw new Error('The playlist has no text')
  const { parent, name } = await checkedTarget(op.to, ctx)
  const to = await firstFreePath(ctx, parent, name)
  const size = Buffer.byteLength(op.content, 'utf8')

  await ctx.journal.write({ type: 'start', i, kind: 'write-m3u', to, size })
  try {
    await ctx.fsImpl.writeFile(to, op.content, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    // "wx" never opens a file that was there already, so unless the error is
    // EEXIST, whatever is at `to` now is this run's half-written playlist
    if (err.code !== 'EEXIST') await removeOwnFile(to, ctx.fsImpl, ctx.log)
    throw err
  }
  await ctx.journal.write({ type: 'done', i })
  await removeMacTwin(to, ctx)
}

const RUNNERS = {
  mkdir: runMkdir,
  copy: runCopy,
  move: runMove,
  rename: runMove,
  'write-m3u': runWritePlaylist
}

// ---------- reading a journal ----------

async function readJournal (journalPath, { fsImpl = fs.promises } = {}) {
  const records = parseRecords(await fsImpl.readFile(journalPath, 'utf8'))
  const [header, ...rest] = records
  if (!isHeader(header)) throw new Error('This is not an organizer journal.')
  return { header, entries: entriesFrom(rest) }
}

// One JSON object per line. A crash can cut the last line short, which is
// left out; any other line that doesn't read means the journal is damaged,
// and undoing from it could leave things half done.
function parseRecords (text) {
  const lines = text.split('\n')
  const isCutShort = !text.endsWith('\n')
  return lines.flatMap((line, index) => {
    if (line === '') return []
    try {
      return [JSON.parse(line)]
    } catch {
      if (isCutShort && index === lines.length - 1) return []
      throw new Error(`The journal is damaged (line ${index + 1}), so nothing was undone.`)
    }
  })
}

function isHeader (record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    record.type === 'header' &&
    record.version === JOURNAL_VERSION &&
    isPlainAbsolute(record.root)
  )
}

function entriesFrom (records) {
  const byIndex = new Map()
  for (const record of records) {
    const i = record?.i
    if (!Number.isSafeInteger(i) || i < 0) continue
    if (record.type === 'start') byIndex.set(i, { ...entryFields(record), state: 'pending', isUndone: false })
    const entry = byIndex.get(i)
    if (!entry) continue
    if (record.type === 'done' || record.type === 'failed') byIndex.set(i, { ...entry, state: record.type })
    if (record.type === 'undone') byIndex.set(i, { ...entry, isUndone: true })
  }
  return [...byIndex.values()].sort((a, b) => a.i - b.i)
}

function entryFields ({ i, kind, from, to, part, size }) {
  return {
    i,
    kind,
    ...(from !== undefined ? { from } : {}),
    to,
    ...(part !== undefined ? { part } : {}),
    ...(size !== undefined ? { size } : {})
  }
}

// ---------- undoing ----------

async function undoJournal ({
  journal,
  journalPath,
  allowedFolders,
  fsImpl = fs.promises,
  onProgress = () => {},
  log = console.log
}) {
  const todo = journal.entries.filter((entry) => !entry.isUndone).reverse()
  const total = todo.length
  const failed = []
  let done = 0
  const ctx = { allowed: await realFolders(allowedFolders, fsImpl, log), fsImpl, log }

  for (const entry of todo) {
    let failure = null
    try {
      await undoEntry(entry, ctx)
      await appendRecord(journalPath, { type: 'undone', i: entry.i }, fsImpl)
    } catch (err) {
      if (err instanceof JournalError) return { status: 'error', done, total, failed: [...failed], error: err.message }
      failure = { operation: publicEntry(entry), error: readableError(err) }
      failed.push(failure)
    }
    done++
    onProgress({ done, total, failed: failed.length, ...(failure ? { failure } : {}) })
  }
  return { status: 'done', done, total, failed: [...failed] }
}

// A target folder that is gone (an unplugged drive) leaves only the others
async function realFolders (folders, fsImpl, log) {
  const resolved = await Promise.all(
    folders.map((folder) =>
      fsImpl.realpath(folder).catch((err) => {
        log(`Undo can't reach ${folder}:`, err.message)
        return null
      })
    )
  )
  return resolved.filter(Boolean)
}

function publicEntry ({ kind, from, to }) {
  return publicOperation({ kind, from, to })
}

const UNDOERS = {
  mkdir: undoMkdir,
  copy: undoCopy,
  move: undoMove,
  rename: undoMove,
  'write-m3u': undoPlaylist
}

async function undoEntry (entry, ctx) {
  if (!isValidEntry(entry)) throw new Error('Not undone: the journal entry is not valid')
  return UNDOERS[entry.kind](entry, ctx)
}

function isValidEntry (entry) {
  if (!KINDS.has(entry.kind) || !isPlainAbsolute(entry.to)) return false
  if (SONG_KINDS.has(entry.kind) && !isPlainAbsolute(entry.from)) return false
  if (SIZED_KINDS.has(entry.kind) && !(Number.isSafeInteger(entry.size) && entry.size >= 0)) return false
  return entry.kind !== 'copy' || entry.part === `${entry.to}${PART_SUFFIX}`
}

// p with its folder resolved (realpath), or null when that folder is gone.
// A journal is a file anyone could edit, so nothing it names outside the
// allowed folders is ever touched.
async function resolvedInside (p, ctx) {
  const outside = new Error('Not undone: the journal points outside the chosen folders')
  if (!isInsideAny(p, ctx.allowed)) throw outside
  let parent
  try {
    parent = await ctx.fsImpl.realpath(path.dirname(p))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!isInsideAny(parent, ctx.allowed)) throw outside
  return path.join(parent, path.basename(p))
}

// A folder the run made goes only when it is empty again (rmdir never
// removes anything inside)
async function undoMkdir (entry, ctx) {
  if (entry.state === 'failed') return
  const folder = await resolvedInside(entry.to, ctx)
  const stat = folder && (await lstatOrNull(folder, ctx.fsImpl))
  if (!stat) return
  if (!stat.isDirectory()) throw new Error('Not removed: it is no longer a folder')
  try {
    await ctx.fsImpl.rmdir(folder)
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') {
      throw new Error('Not removed: the folder is not empty (hidden files such as .DS_Store count too)')
    }
    throw err
  }
}

async function undoCopy (entry, ctx) {
  // a failed copy never got its name (its own clean-up removed the .part)
  if (entry.state !== 'failed') await removeIfUnchanged(entry.to, entry.size, ctx)
  const part = await resolvedInside(entry.part, ctx)
  const stat = part && (await lstatOrNull(part, ctx.fsImpl))
  if (!stat) return
  if (!stat.isFile() || stat.size !== entry.size) {
    throw new Error(`A half-written copy was left at ${entry.part}; delete it if you don't need it`)
  }
  await ctx.fsImpl.unlink(part)
}

async function undoPlaylist (entry, ctx) {
  if (entry.state !== 'failed') await removeIfUnchanged(entry.to, entry.size, ctx)
}

// A file this run wrote, removed only while it is still what it wrote
async function removeIfUnchanged (filePath, size, ctx) {
  const target = await resolvedInside(filePath, ctx)
  const stat = target && (await lstatOrNull(target, ctx.fsImpl))
  if (!stat) return // already gone
  if (!stat.isFile() || stat.size !== size) {
    throw new Error("Not removed: it changed since (its size isn't what the journal recorded)")
  }
  await ctx.fsImpl.unlink(target)
}

// A moved or renamed song goes back to where it was, never over anything
async function undoMove (entry, ctx) {
  if (entry.state === 'failed') return
  const from = await resolvedInside(entry.from, ctx)
  const to = await resolvedInside(entry.to, ctx)
  if (!from) throw new Error(`Not put back: the folder ${path.dirname(entry.from)} is gone`)
  const atTo = to && (await lstatOrNull(to, ctx.fsImpl))
  const atFrom = await lstatOrNull(from, ctx.fsImpl)

  if (!atTo) {
    if (atFrom) return // never moved (a crash came first), or already put back
    throw new Error('Not put back: the song is not where it was moved to any more')
  }
  // a change of case only: both names are the same file
  const isSameFile = atFrom && atFrom.dev === atTo.dev && atFrom.ino === atTo.ino
  if (atFrom && !isSameFile) throw new Error(`Not put back: something else is already at ${entry.from}`)
  if (!atTo.isFile()) throw new Error('Not put back: it is no longer a file')
  await ctx.fsImpl.rename(to, from)
}

module.exports = {
  JOURNAL_FOLDER,
  createJournal,
  applyOperations,
  readJournal,
  undoJournal,
  readableError
}
