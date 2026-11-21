// organizer/apply.js carries a plan out on the person's music, one operation
// at a time, writing an undo journal entry before each, and undoes a run (a
// finished one, or one cut short by a crash) from that journal. These songs
// are someone's music collection, so the tests are mostly about what must
// never happen: overwriting, deleting a song, touching anything outside the
// chosen folders. Everything runs in temp folders.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createJournal, applyOperations, readJournal, undoJournal } = require('../organizer/apply')
const { buildPlan } = require('../organizer/plan')
const { scanFolder, inspectTargets } = require('../organizer/scan')

const JOURNAL_FOLDER = '.zipify-organizer'

function quiet () {}

function makeTempFolder (t, prefix = 'organizer-apply-') {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return folder
}

function writeFile (filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

function read (filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

// Every folder and file under root (with a hash of its bytes), leaving out
// the journal folder: what "exactly as it was" means
function snapshot (root) {
  const lines = []
  const walk = (folder, rel) => {
    for (const name of fs.readdirSync(folder).sort()) {
      if (rel === '' && name === JOURNAL_FOLDER) continue
      const full = path.join(folder, name)
      const relName = rel ? `${rel}/${name}` : name
      if (fs.lstatSync(full).isDirectory()) {
        lines.push(`${relName}/`)
        walk(full, relName)
      } else {
        lines.push(`${relName} ${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`)
      }
    }
  }
  walk(root, '')
  return lines
}

function journalRecords (journalPath) {
  return fs
    .readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function run (root, operations, { allowedFolders = [root], fsImpl, journalFs } = {}) {
  const journal = await createJournal({ root, action: 'test', allowedFolders, fsImpl: journalFs })
  const result = await applyOperations({ operations, root, allowedFolders, journal, fsImpl, log: quiet })
  return { result, journalPath: journal.path }
}

async function undo (journalPath, { allowedFolders, fsImpl } = {}) {
  const journal = await readJournal(journalPath)
  return undoJournal({
    journal,
    journalPath,
    allowedFolders: allowedFolders ?? [journal.header.root],
    fsImpl,
    log: quiet
  })
}

// fs.promises with some functions swapped for the test's own
function fsWith (overrides) {
  return { ...fs.promises, ...overrides }
}

function fsError (code) {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

// ---------- a small library, scanned and planned for real ----------

const LIBRARY = {
  'Kesariya.mp3': 'kesariya audio',
  'Old/Kesariya.mp3': 'kesariya audio',
  'Bollywood/Tum Hi Ho.mp3': 'tum hi ho audio',
  'Bollywood/notes.txt': 'not a song'
}
const TAGS = {
  'Kesariya.mp3': { title: 'Kesariya', artist: 'Pritam', genre: 'Filmi' },
  'Tum Hi Ho.mp3': { title: 'Tum Hi Ho', artist: 'Arijit Singh', genre: 'Filmi', track: 3 }
}

function makeLibrary (t) {
  const root = makeTempFolder(t)
  for (const [rel, content] of Object.entries(LIBRARY)) writeFile(path.join(root, ...rel.split('/')), content)
  return root
}

async function readFakeTags (filePath) {
  return TAGS[path.basename(filePath)] ?? {}
}

async function planFor (root, action, options) {
  const scan = await scanFolder(root, { readTags: readFakeTags, log: quiet })
  const input = { root: scan.root, songs: scan.songs, songIds: scan.songs.map((s) => s.id), action, options }
  const first = buildPlan(input)
  return buildPlan({ ...input, existing: await inspectTargets(first.operations, { log: quiet }) })
}

async function organize (root, action, options, { fsImpl, journalFs } = {}) {
  const plan = await planFor(root, action, options)
  const { result, journalPath } = await run(root, plan.operations, {
    allowedFolders: plan.allowedFolders,
    fsImpl,
    journalFs
  })
  return { plan, result, journalPath }
}

// ---------- applying ----------

describe('applyOperations', () => {
  test('makes folders, copies, moves, renames and writes the playlist, in order', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    writeFile(path.join(root, 'sub', 'b.mp3'), 'BB')
    writeFile(path.join(root, 'c.mp3'), 'CCC')
    const P = path.join(root, 'P')
    const operations = [
      { kind: 'mkdir', to: P, fresh: true },
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(P, '01 - a.mp3'), songId: 'a' },
      { kind: 'move', from: path.join(root, 'sub', 'b.mp3'), to: path.join(P, '02 - b.mp3'), songId: 'b' },
      { kind: 'rename', from: path.join(root, 'c.mp3'), to: path.join(root, 'C3.mp3'), songId: 'c' },
      { kind: 'write-m3u', to: path.join(P, 'P.m3u'), content: '#EXTM3U\n01 - a.mp3\n02 - b.mp3\n' }
    ]
    const updates = []
    const journal = await createJournal({ root, action: 'playlist', allowedFolders: [root] })
    const result = await applyOperations({
      operations,
      root,
      allowedFolders: [root],
      journal,
      log: quiet,
      onProgress: (p) => updates.push(p)
    })

    assert.deepEqual(result, { status: 'done', done: 5, total: 5, failed: [] })
    assert.deepEqual(updates.at(-1), { done: 5, total: 5, failed: 0 })
    assert.equal(read(path.join(root, 'a.mp3')), 'A') // a copy leaves the song where it was
    assert.equal(read(path.join(P, '01 - a.mp3')), 'A')
    assert.equal(read(path.join(P, '02 - b.mp3')), 'BB')
    assert.equal(fs.existsSync(path.join(root, 'sub', 'b.mp3')), false)
    assert.equal(read(path.join(root, 'C3.mp3')), 'CCC')
    assert.equal(fs.existsSync(path.join(root, 'c.mp3')), false)
    assert.equal(read(path.join(P, 'P.m3u')), '#EXTM3U\n01 - a.mp3\n02 - b.mp3\n')
    assert.equal(path.dirname(journal.path), path.join(root, JOURNAL_FOLDER))
    assert.match(path.basename(journal.path), /^journal-[0-9T-]+Z(-\d+)?\.json$/)
  })

  test('never overwrites: a taken name gets " (2)", and a leftover .part is stepped around', async (t) => {
    const root = makeTempFolder(t)
    const dest = path.join(root, 'dest')
    writeFile(path.join(root, 'x.mp3'), 'new')
    writeFile(path.join(root, 'y.mp3'), 'yy')
    writeFile(path.join(dest, 'x.mp3'), 'old')
    writeFile(path.join(dest, 'x (2).mp3.part'), 'stale')
    writeFile(path.join(dest, 'list.m3u'), 'old list')
    const { result } = await run(root, [
      { kind: 'copy', from: path.join(root, 'x.mp3'), to: path.join(dest, 'x.mp3') },
      { kind: 'move', from: path.join(root, 'y.mp3'), to: path.join(dest, 'x.mp3') },
      { kind: 'write-m3u', to: path.join(dest, 'list.m3u'), content: '#EXTM3U\n' }
    ])

    assert.deepEqual(result.failed, [])
    assert.equal(read(path.join(dest, 'x.mp3')), 'old')
    assert.equal(read(path.join(dest, 'x (2).mp3.part')), 'stale')
    assert.equal(read(path.join(dest, 'x (3).mp3')), 'new')
    assert.equal(read(path.join(dest, 'x (2).mp3')), 'yy')
    assert.equal(read(path.join(dest, 'list.m3u')), 'old list')
    assert.equal(read(path.join(dest, 'list (2).m3u')), '#EXTM3U\n')
  })

  test('a file that turns up at the last moment is not overwritten either', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    const fsImpl = fsWith({
      copyFile: async (from, to, mode) => {
        fs.writeFileSync(to, 'intruder') // appears after the name was checked
        return fs.promises.copyFile(from, to, mode)
      }
    })
    const { result } = await run(root, [{ kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(root, 'b.mp3') }], { fsImpl })

    assert.match(result.failed[0].error, /already there/)
    assert.equal(read(path.join(root, 'b.mp3.part')), 'intruder')
    assert.equal(fs.existsSync(path.join(root, 'b.mp3')), false)
  })

  test('writes each journal entry before its operation, and marks it done after', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    writeFile(path.join(root, 'b.mp3'), 'B')
    const journal = await createJournal({ root, action: 'test', allowedFolders: [root] })
    const seen = []
    const watch = (name) => async (...args) => {
      seen.push({ name, last: journalRecords(journal.path).at(-1) })
      return fs.promises[name](...args)
    }
    const fsImpl = fsWith({ mkdir: watch('mkdir'), copyFile: watch('copyFile'), rename: watch('rename'), writeFile: watch('writeFile') })

    await applyOperations({
      operations: [
        { kind: 'mkdir', to: path.join(root, 'new') },
        { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(root, 'new', 'a.mp3') },
        { kind: 'rename', from: path.join(root, 'b.mp3'), to: path.join(root, 'b2.mp3') },
        { kind: 'write-m3u', to: path.join(root, 'new', 'l.m3u'), content: 'x' }
      ],
      root,
      allowedFolders: [root],
      journal,
      fsImpl,
      log: quiet
    })

    assert.deepEqual(
      seen.map(({ name, last }) => `${name} after ${last.type} ${last.i} ${last.kind}`),
      [
        'mkdir after start 0 mkdir',
        'copyFile after start 1 copy',
        'rename after start 1 copy', // the finished copy taking its name
        'rename after start 2 rename',
        'writeFile after start 3 write-m3u'
      ]
    )
    const records = journalRecords(journal.path)
    assert.deepEqual(
      records.map((r) => (r.i === undefined ? r.type : `${r.type} ${r.i}`)),
      ['header', 'start 0', 'done 0', 'start 1', 'done 1', 'start 2', 'done 2', 'start 3', 'done 3', 'end']
    )
    assert.deepEqual(records[3], {
      type: 'start',
      i: 1,
      kind: 'copy',
      from: path.join(root, 'a.mp3'),
      to: path.join(root, 'new', 'a.mp3'),
      part: path.join(root, 'new', 'a.mp3.part'),
      size: 1
    })
    assert.equal(records[0].root, root)
  })

  test('keeps going after a failed operation, and says what went wrong in plain words', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    const missing = { kind: 'copy', from: path.join(root, 'gone.mp3'), to: path.join(root, 'g.mp3'), songId: 'g' }
    const { result } = await run(root, [
      missing,
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(root, 'a2.mp3') }
    ])

    assert.equal(result.status, 'done')
    assert.equal(result.done, 2)
    assert.deepEqual(result.failed, [
      { operation: missing, error: 'It is not there any more (ENOENT)' }
    ])
    assert.equal(read(path.join(root, 'a2.mp3')), 'A')
  })

  test('refuses anything outside the scanned folder and the chosen target', async (t) => {
    const root = makeTempFolder(t)
    const outside = makeTempFolder(t, 'organizer-outside-')
    writeFile(path.join(root, 'a.mp3'), 'A')
    writeFile(path.join(outside, 'secret.mp3'), 'S')
    fs.symlinkSync(path.join(root, 'a.mp3'), path.join(root, 'link.mp3'))
    fs.symlinkSync(outside, path.join(root, 'escape'))
    const outsideBefore = snapshot(outside)

    const { result } = await run(root, [
      { kind: 'copy', from: path.join(outside, 'secret.mp3'), to: path.join(root, 's.mp3') },
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(outside, 'a.mp3') },
      { kind: 'move', from: path.join(root, 'link.mp3'), to: path.join(root, 'l2.mp3') },
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(root, 'escape', 'a.mp3') },
      { kind: 'move', from: `${root}/../${path.basename(outside)}/secret.mp3`, to: path.join(root, 's.mp3') },
      { kind: 'mkdir', to: path.join(outside, 'new') },
      { kind: 'write-m3u', to: path.join(root, 'escape', 'x.m3u'), content: 'x' },
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(root, 'ok.mp3') }
    ])

    assert.equal(result.failed.length, 7)
    assert.deepEqual(snapshot(outside), outsideBefore)
    assert.equal(fs.existsSync(path.join(root, 's.mp3')), false)
    assert.equal(fs.lstatSync(path.join(root, 'link.mp3')).isSymbolicLink(), true)
    assert.equal(read(path.join(root, 'ok.mp3')), 'A')
  })

  test('a folder that must be new but appeared meanwhile becomes "<name> (2)", and its contents follow', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    writeFile(path.join(root, 'P', 'old.mp3'), 'old')
    const P = path.join(root, 'P')
    const { result } = await run(root, [
      { kind: 'mkdir', to: P, fresh: true },
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(P, 'a.mp3') },
      { kind: 'write-m3u', to: path.join(P, 'P.m3u'), content: '#EXTM3U\na.mp3\n' }
    ])

    assert.deepEqual(result.failed, [])
    assert.deepEqual(fs.readdirSync(P), ['old.mp3'])
    assert.deepEqual(fs.readdirSync(path.join(root, 'P (2)')).sort(), ['P.m3u', 'a.mp3'])
  })

  test('removes the "._" twin macOS writes beside a copy on FAT32, and nothing that merely looks like one', async (t) => {
    const root = makeTempFolder(t)
    const dest = path.join(root, 'dest')
    writeFile(path.join(root, 'a.mp3'), 'A')
    // AppleDouble files start with 00 05 16 07; a song named "._c.mp3" doesn't
    const appleDouble = Buffer.concat([Buffer.from([0x00, 0x05, 0x16, 0x07]), Buffer.alloc(60)])
    writeFile(path.join(dest, '._b.mp3'), appleDouble)
    writeFile(path.join(dest, '._b.mp3.part'), appleDouble)
    writeFile(path.join(dest, '._c.mp3'), 'ID3 a real song with an odd name')

    const { result } = await run(root, [
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(dest, 'b.mp3') },
      { kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(dest, 'c.mp3') }
    ])

    assert.deepEqual(result.failed, [])
    assert.deepEqual(fs.readdirSync(dest).sort(), ['._c.mp3', 'b.mp3', 'c.mp3'])
    assert.equal(read(path.join(dest, '._c.mp3')), 'ID3 a real song with an odd name')
  })

  test('a change of case only is a plain rename', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'tum hi ho.mp3'), 'T')
    const { result } = await run(root, [
      { kind: 'rename', from: path.join(root, 'tum hi ho.mp3'), to: path.join(root, 'Tum Hi Ho.mp3') }
    ])

    assert.deepEqual(result.failed, [])
    assert.deepEqual(fs.readdirSync(root).filter((n) => !n.startsWith('.')), ['Tum Hi Ho.mp3'])
  })

  test('moving between drives is refused, never done as a copy and a delete', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    const fsImpl = fsWith({ rename: async () => { throw fsError('EXDEV') } })
    const { result } = await run(root, [{ kind: 'move', from: path.join(root, 'a.mp3'), to: path.join(root, 'b.mp3') }], { fsImpl })

    assert.match(result.failed[0].error, /between drives/)
    assert.equal(read(path.join(root, 'a.mp3')), 'A')
  })

  test('a failed copy leaves no half-written file behind', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'AAAAAAAAAA')
    const fsImpl = fsWith({
      copyFile: async (from, to) => {
        fs.writeFileSync(to, 'AAA')
        throw fsError('ENOSPC')
      }
    })
    const { result } = await run(root, [{ kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(root, 'b.mp3') }], { fsImpl })

    assert.match(result.failed[0].error, /drive is full/)
    assert.deepEqual(fs.readdirSync(root).filter((n) => !n.startsWith('.')), ['a.mp3'])
  })

  test('a copy that silently comes out short is thrown away, never given the song\'s name', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'AAAAAAAAAA')
    const fsImpl = fsWith({ copyFile: async (from, to) => fs.writeFileSync(to, 'AAAA') })
    const { result } = await run(root, [{ kind: 'copy', from: path.join(root, 'a.mp3'), to: path.join(root, 'b.mp3') }], { fsImpl })

    assert.match(result.failed[0].error, /4 bytes long instead of 10/)
    assert.deepEqual(fs.readdirSync(root).filter((n) => !n.startsWith('.')), ['a.mp3'])
  })

  test('stops after many failures in a row: the drive is probably gone', async (t) => {
    const root = makeTempFolder(t)
    const operations = Array.from({ length: 40 }, (_, i) => ({
      kind: 'copy',
      from: path.join(root, `missing ${i}.mp3`),
      to: path.join(root, `copy ${i}.mp3`)
    }))
    const { result } = await run(root, operations)

    assert.equal(result.status, 'error')
    assert.match(result.error, /in a row/)
    assert.equal(result.done, 25)
    assert.equal(result.total, 40)
  })

  test('stops at once when the journal can no longer be written', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    writeFile(path.join(root, 'b.mp3'), 'B')
    const journalFs = fsWith({ appendFile: async () => { throw fsError('ENOSPC') } })
    const { result } = await run(
      root,
      [
        { kind: 'rename', from: path.join(root, 'a.mp3'), to: path.join(root, 'a2.mp3') },
        { kind: 'rename', from: path.join(root, 'b.mp3'), to: path.join(root, 'b2.mp3') }
      ],
      { journalFs }
    )

    assert.equal(result.status, 'error')
    assert.match(result.error, /journal/i)
    assert.equal(result.done, 0)
    assert.deepEqual(fs.readdirSync(root).filter((n) => !n.startsWith('.')).sort(), ['a.mp3', 'b.mp3'])
  })

  test('a journal never replaces another', async (t) => {
    const root = makeTempFolder(t)
    const now = () => Date.UTC(2026, 10, 21, 10, 30, 0, 123)
    const first = await createJournal({ root, action: 'sort', allowedFolders: [root], now })
    const second = await createJournal({ root, action: 'sort', allowedFolders: [root], now })

    assert.equal(path.basename(first.path), 'journal-2026-11-21T10-30-00-123Z.json')
    assert.equal(path.basename(second.path), 'journal-2026-11-21T10-30-00-123Z-2.json')
  })
})

// ---------- undoing ----------

describe('undoJournal', () => {
  const RUNS = [
    ['sort, moving by artist', 'sort', { groupBy: 'artist', mode: 'move' }],
    ['sort, copying by genre', 'sort', { groupBy: 'genre', mode: 'copy' }],
    ['a numbered playlist with its .m3u', 'playlist', { name: 'Car', mode: 'move', numberTracks: true, writePlaylist: true }],
    ['renaming', 'rename', { pattern: '{track} {title}' }],
    ['setting duplicates aside', 'dedupe', { keep: 'first' }]
  ]

  for (const [label, action, options] of RUNS) {
    test(`puts everything back exactly as it was after ${label}`, async (t) => {
      const root = makeLibrary(t)
      const before = snapshot(root)
      const { result, journalPath } = await organize(root, action, options)
      assert.deepEqual(result.failed, [])
      assert.notDeepEqual(snapshot(root), before)

      const undone = await undo(journalPath)

      assert.equal(undone.status, 'done')
      assert.deepEqual(undone.failed, [])
      assert.deepEqual(snapshot(root), before)
    })
  }

  test('a crash halfway (the journal stops being written) can be undone', async (t) => {
    const root = makeLibrary(t)
    const before = snapshot(root)
    let appends = 0
    const journalFs = fsWith({
      appendFile: async (...args) => {
        if (++appends === 6) throw fsError('EIO') // the third operation is done, but never marked so
        return fs.promises.appendFile(...args)
      }
    })
    const { result, journalPath } = await organize(root, 'sort', { groupBy: 'artist', mode: 'move' }, { journalFs })
    assert.equal(result.status, 'error')
    assert.notDeepEqual(snapshot(root), before)

    const undone = await undo(journalPath)

    assert.deepEqual(undone.failed, [])
    assert.deepEqual(snapshot(root), before)
  })

  test('an operation that failed partway leaves nothing behind once undone', async (t) => {
    const root = makeLibrary(t)
    const before = snapshot(root)
    let copies = 0
    const fsImpl = fsWith({
      copyFile: async (from, to, mode) => {
        if (++copies === 2) {
          fs.writeFileSync(to, 'half')
          throw fsError('EIO')
        }
        return fs.promises.copyFile(from, to, mode)
      }
    })
    const { result, journalPath } = await organize(root, 'sort', { groupBy: 'artist', mode: 'copy' }, { fsImpl })
    assert.equal(result.failed.length, 1)

    const undone = await undo(journalPath)

    assert.deepEqual(undone.failed, [])
    assert.deepEqual(snapshot(root), before)
  })

  test('never removes a copy that changed since, nor a half-written one', async (t) => {
    const root = makeLibrary(t)
    const { journalPath } = await organize(root, 'sort', { groupBy: 'artist', mode: 'copy' })
    const edited = path.join(root, 'Organized', 'Arijit Singh', 'Tum Hi Ho.mp3')
    fs.appendFileSync(edited, ' with new tags')

    const undone = await undo(journalPath)

    // the edited copy stays, and so do the two folders holding it
    assert.deepEqual(
      undone.failed.map((f) => path.relative(root, f.operation.to)),
      [path.join('Organized', 'Arijit Singh', 'Tum Hi Ho.mp3'), path.join('Organized', 'Arijit Singh'), 'Organized']
    )
    assert.match(undone.failed[0].error, /changed/)
    assert.match(undone.failed[1].error, /not empty/)
    assert.equal(read(edited), 'tum hi ho audio with new tags')
    assert.equal(fs.existsSync(path.join(root, 'Organized', 'Pritam')), false)

    const half = makeTempFolder(t)
    writeFile(path.join(half, 'a.mp3'), '0123456789')
    writeFile(path.join(half, 'x', 'a.mp3.part'), '0123')
    const handMade = writeFile(
      path.join(half, JOURNAL_FOLDER, 'journal-crash.json'),
      [
        { type: 'header', version: 1, root: half, action: 'sort', allowedFolders: [half] },
        { type: 'start', i: 0, kind: 'mkdir', to: path.join(half, 'x') },
        { type: 'done', i: 0 },
        { type: 'start', i: 1, kind: 'copy', from: path.join(half, 'a.mp3'), to: path.join(half, 'x', 'a.mp3'), part: path.join(half, 'x', 'a.mp3.part'), size: 10 }
      ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    )

    const crashed = await undo(handMade)

    assert.match(crashed.failed[0].error, /half-written copy/)
    assert.equal(read(path.join(half, 'x', 'a.mp3.part')), '0123')
    assert.equal(read(path.join(half, 'a.mp3')), '0123456789')
  })

  test('never puts a file back over one that took its place', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'a.mp3'), 'A')
    const { journalPath } = await run(root, [{ kind: 'rename', from: path.join(root, 'a.mp3'), to: path.join(root, 'b.mp3') }])
    writeFile(path.join(root, 'a.mp3'), 'a newer song')

    const undone = await undo(journalPath)

    assert.match(undone.failed[0].error, /already/)
    assert.equal(read(path.join(root, 'a.mp3')), 'a newer song')
    assert.equal(read(path.join(root, 'b.mp3')), 'A')
  })

  test('refuses journal entries that point outside the allowed folders', async (t) => {
    const root = makeTempFolder(t)
    const outside = makeTempFolder(t, 'organizer-outside-')
    const victim = writeFile(path.join(outside, 'victim.mp3'), 'precious')
    writeFile(path.join(root, 'a.mp3'), 'precious')
    fs.symlinkSync(outside, path.join(root, 'escape'))
    const viaLink = path.join(root, 'escape', 'victim.mp3') // looks inside, leads outside
    const handMade = writeFile(
      path.join(root, JOURNAL_FOLDER, 'journal-evil.json'),
      [
        { type: 'header', version: 1, root, action: 'sort', allowedFolders: [root, outside] },
        { type: 'start', i: 0, kind: 'copy', from: path.join(root, 'a.mp3'), to: victim, part: `${victim}.part`, size: 8 },
        { type: 'done', i: 0 },
        { type: 'start', i: 1, kind: 'move', from: path.join(outside, 'moved.mp3'), to: path.join(root, 'a.mp3'), size: 8 },
        { type: 'done', i: 1 },
        { type: 'start', i: 2, kind: 'copy', from: path.join(root, 'a.mp3'), to: viaLink, part: `${viaLink}.part`, size: 8 },
        { type: 'done', i: 2 }
      ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    )

    const undone = await undo(handMade, { allowedFolders: [root] })

    assert.equal(undone.failed.length, 3)
    assert.ok(undone.failed.every((f) => /outside/.test(f.error)))
    assert.equal(read(victim), 'precious')
    assert.equal(read(path.join(root, 'a.mp3')), 'precious')
  })

  test('undoing twice changes nothing more', async (t) => {
    const root = makeLibrary(t)
    const before = snapshot(root)
    const { journalPath } = await organize(root, 'sort', { groupBy: 'artist', mode: 'move' })
    await undo(journalPath)

    const again = await undo(journalPath)

    assert.equal(again.status, 'done')
    assert.deepEqual(again.failed, [])
    assert.deepEqual(snapshot(root), before)
    assert.ok(journalRecords(journalPath).some((r) => r.type === 'undone'))
  })
})

describe('readJournal', () => {
  test('reads a journal whose last line a crash cut short', async (t) => {
    const root = makeTempFolder(t)
    const journalPath = writeFile(
      path.join(root, JOURNAL_FOLDER, 'journal-x.json'),
      JSON.stringify({ type: 'header', version: 1, root, action: 'sort', allowedFolders: [root] }) + '\n' +
        JSON.stringify({ type: 'start', i: 0, kind: 'mkdir', to: path.join(root, 'A') }) + '\n' +
        '{"type":"do'
    )

    const journal = await readJournal(journalPath)

    assert.equal(journal.header.root, root)
    assert.deepEqual(journal.entries, [
      { i: 0, kind: 'mkdir', to: path.join(root, 'A'), state: 'pending', isUndone: false }
    ])
  })

  test('refuses a damaged journal, or a file that is not one', async (t) => {
    const root = makeTempFolder(t)
    const header = JSON.stringify({ type: 'header', version: 1, root, action: 'sort', allowedFolders: [root] })
    const damaged = writeFile(path.join(root, 'damaged.json'), `${header}\nnot json\n{"type":"done","i":0}\n`)
    const notOne = writeFile(path.join(root, 'other.json'), '{"hello":"world"}\n')

    await assert.rejects(readJournal(damaged), /damaged/)
    await assert.rejects(readJournal(notOne), /not an organizer journal/)
  })
})
