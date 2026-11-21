// The organizer on HTTP: scan a folder (usually a pen drive), plan a change
// for the songs the person selected (sort into folders, rename, gather into
// a playlist folder, set duplicates aside), carry it out, and undo it. The
// work itself is done by organizer/scan.js, plan.js and apply.js.
//
// server.js mounts it with one line, after its own checks:
//   app.use(createOrganizerRouter({ checkSaveFolder }))
// Only /organizer/… requests are touched; the router reads their JSON
// bodies itself (2 MB at most).
//
// JSON in and out. An error is { error } with 400 (bad request), 404
// (unknown or forgotten id), 409 (the folder is busy, or changed since) or
// 500 (the disk failed).
//
//   POST /organizer/scan { folder, maxDepth? (1-6, default 4) } -> { scanId }
//   GET  /organizer/scan/:id
//     -> { status: 'scanning' | 'done' | 'error', found, scanned, root,
//          truncated, error?, songs? (once done: scan.js's Song objects) }
//   POST /organizer/plan { scanId, songIds, action, options }
//     -> { planId, operations: [{ kind, from?, to, songId? }],
//          conflicts: [{ songId, reason }], summary, targetFolder, groups? }
//     songIds: the selected songs in the order shown, at most 20 000.
//     action and options: see plan.js. A targetFolder inside the scanned
//     folder may not exist yet; one outside it must be a folder that
//     checkSaveFolder accepts (and, to move songs there, on the same drive).
//   POST /organizer/apply { planId } -> { applyId }       (a plan runs once)
//   POST /organizer/undo { journalPath } -> { applyId }
//   GET  /organizer/apply/:id
//     -> { kind: 'apply' | 'undo', status: 'running' | 'done' | 'error',
//          done, total, failed: [{ operation, error }], journalPath, error? }
//
// Scans, plans and runs live in memory, forgotten 30 minutes after they
// finish (a plan 30 minutes after it was made). One scan, apply or undo at a
// time per folder; a folder inside or around a busy one counts as the same.
// Once an apply or undo starts, scans and plans of the folders it changes
// are out of date (409: scan again). An undo may reach outside the scanned
// folder only for a journal this server wrote: a journal is a file anyone
// could edit, so after a restart undo stays inside the journal's own folder.
//
// createOrganizerRouter({ checkSaveFolder, log, now, ttlMs, readTags, fsImpl })
//   checkSaveFolder  save-folder.js's (folder) -> Promise<problem | null>
//   readTags, fsImpl, now, ttlMs  stand-ins for tests

const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')
const express = require('express')
const { scanFolder, inspectTargets } = require('./scan')
const { buildPlan, planProblem, publicOperation, isInside, pathKey } = require('./plan')
const {
  JOURNAL_FOLDER,
  createJournal,
  applyOperations,
  readJournal,
  undoJournal,
  readableError
} = require('./apply')

const TTL_MS = 30 * 60 * 1000
const DEFAULT_DEPTH = 4
const MAX_DEPTH = 6
const MAX_SONG_IDS = 20000
const MAX_PATH_CHARS = 4096
// 20 000 song ids are about 400 KB of JSON
const BODY_LIMIT = '2mb'
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SONG_ID = /^[0-9a-f]{16}$/
const JOURNAL_NAME = /^journal-[0-9A-Za-z-]+\.json$/
const TARGET_ACTIONS = new Set(['sort', 'playlist'])

const BUSY = 'That folder is busy: a scan or a change is running there. Try again once it has finished.'
const SCAN_CHANGED = 'The folder changed since this scan. Scan it again.'
const PLAN_CHANGED = 'The folder changed since this plan was made. Scan it again.'
const NO_SCAN = 'No such scan: a scan is forgotten 30 minutes after it finishes. Scan the folder again.'
const NO_PLAN = 'No such plan: a plan is forgotten 30 minutes after it is made. Plan again.'
const NO_RUN = 'No such run: a run is forgotten 30 minutes after it finishes.'
const BODY_ERRORS = {
  'entity.parse.failed': 'The request body is not valid JSON.',
  'entity.too.large': 'Too much data in one request.'
}

function httpError (status, message) {
  return Object.assign(new Error(message), { httpStatus: status })
}

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireObject (body, message) {
  if (!isPlainObject(body)) throw httpError(400, message)
  return body
}

// the first item that comes up a second time, or null
function firstRepeat (items) {
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item)) return item
    seen.add(item)
  }
  return null
}

// Two folders are one busy place when either holds the other (case ignored,
// as FAT32 and macOS do)
function overlaps (a, b) {
  return isInside(pathKey(a), pathKey(b)) || isInside(pathKey(b), pathKey(a))
}

async function lstatOrNull (p) {
  try {
    return await fs.promises.lstat(p)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// ---------- in-memory state ----------

// Records are replaced, never changed in place, so a reply never sees one
// half updated
function createStore () {
  const records = new Map()
  return {
    get: (id) => records.get(id) ?? null,
    add: (record) => records.set(record.id, record).get(record.id),
    update: (id, changes) => {
      const record = records.get(id)
      if (record) records.set(id, { ...record, ...changes })
    },
    sweep: (isExpired) => {
      for (const [id, record] of records) if (isExpired(record)) records.delete(id)
    }
  }
}

// The folders being scanned or changed; claim() gives a release function,
// or null when one of the folders is busy
function createLocks () {
  const held = new Map()
  return {
    claim (folders) {
      const busy = [...held.values()].flat()
      if (busy.some((taken) => folders.some((folder) => overlaps(folder, taken)))) return null
      const id = randomUUID()
      held.set(id, folders)
      return () => held.delete(id)
    }
  }
}

// Each apply or undo, numbered: a scan (and the plans made from it) knows
// the number it saw, so it can tell whether its folder was changed since
function createChangeLog () {
  const changes = []
  return {
    latest: () => changes.length,
    record: (folders) => changes.push({ seq: changes.length + 1, folders }),
    isOutOfDate: (folders, seenSeq) =>
      changes.some((c) => c.seq > seenSeq && c.folders.some((f) => folders.some((folder) => overlaps(f, folder))))
  }
}

// ---------- the router ----------

function createOrganizerRouter ({
  checkSaveFolder,
  log = console.log,
  now = Date.now,
  ttlMs = TTL_MS,
  readTags,
  fsImpl
} = {}) {
  if (typeof checkSaveFolder !== 'function') {
    throw new TypeError('createOrganizerRouter needs checkSaveFolder (from save-folder.js)')
  }
  const scans = createStore()
  const plans = createStore()
  const runs = createStore()
  const locks = createLocks()
  const changeLog = createChangeLog()
  // journal path -> the folders its run was allowed to change
  const journals = new Map()
  const withFs = fsImpl ? { fsImpl } : {}

  function sweep () {
    const cutoff = now() - ttlMs
    scans.sweep((scan) => scan.finishedAt !== null && scan.finishedAt < cutoff)
    plans.sweep((plan) => plan.createdAt < cutoff)
    runs.sweep((run) => run.finishedAt !== null && run.finishedAt < cutoff)
  }

  function findRecord (store, id, label, missing) {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) throw httpError(400, `That is not a ${label} id.`)
    const record = store.get(id)
    if (!record) throw httpError(404, missing)
    return record
  }

  // ----- scanning -----

  async function checkedFolder (value) {
    if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'Choose a folder to scan.')
    const folder = value.trim()
    if (folder.length > MAX_PATH_CHARS) throw httpError(400, 'The folder path is too long.')
    if (!path.isAbsolute(folder)) throw httpError(400, 'The folder must be a full path, like /Volumes/MyDrive/Music.')
    const problem = await checkSaveFolder(folder)
    if (problem) throw httpError(400, problem)
    return fs.promises.realpath(folder)
  }

  async function startScan (req) {
    const body = requireObject(req.body, 'Send the folder to scan as JSON, like {"folder": "/Volumes/MyDrive"}.')
    if (typeof body.folder !== 'string') throw httpError(400, 'Choose a folder to scan.')
    const maxDepth = body.maxDepth ?? DEFAULT_DEPTH
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_DEPTH) {
      throw httpError(400, `maxDepth must be a whole number from 1 to ${MAX_DEPTH}.`)
    }
    const root = await checkedFolder(body.folder)
    const release = locks.claim([root])
    if (!release) throw httpError(409, BUSY)

    const scan = scans.add({
      id: randomUUID(),
      status: 'scanning',
      root,
      found: 0,
      scanned: 0,
      truncated: false,
      seenSeq: changeLog.latest(),
      finishedAt: null
    })
    runScan(scan.id, root, maxDepth, release)
    return { scanId: scan.id }
  }

  // Never rejects. The folder is released in the same step that shows the
  // scan as finished, so a page that sees "done" can scan again at once.
  async function runScan (id, root, maxDepth, release) {
    try {
      const result = await scanFolder(root, {
        maxDepth,
        log,
        ...(readTags ? { readTags } : {}),
        onProgress: ({ found, scanned }) => scans.update(id, { found, scanned })
      })
      release()
      scans.update(id, {
        status: 'done',
        root: result.root,
        songs: result.songs,
        songsById: new Map(result.songs.map((song) => [song.id, song])),
        truncated: result.truncated,
        found: result.songs.length,
        scanned: result.songs.length,
        finishedAt: now()
      })
    } catch (err) {
      release()
      log(`Could not scan ${root}:`, err)
      scans.update(id, { status: 'error', error: `Could not scan ${root}: ${readableError(err)}`, finishedAt: now() })
    }
  }

  function getScan (req) {
    const { status, found, scanned, root, truncated, error, songs } = findRecord(scans, req.params.id, 'scan', NO_SCAN)
    return {
      status,
      found,
      scanned,
      root,
      truncated,
      ...(error ? { error } : {}),
      ...(status === 'done' ? { songs } : {})
    }
  }

  // ----- planning -----

  function checkedSongIds (value, scan) {
    if (!Array.isArray(value) || value.length === 0) throw httpError(400, 'Select at least one song.')
    if (value.length > MAX_SONG_IDS) throw httpError(400, `Select at most ${MAX_SONG_IDS} songs at a time.`)
    const bad = value.findIndex((id) => typeof id !== 'string' || !SONG_ID.test(id))
    if (bad !== -1) throw httpError(400, `Item ${bad + 1} of the list is not a song id (16 hex digits).`)
    const repeated = firstRepeat(value)
    if (repeated) throw httpError(400, `Song ${repeated} is selected more than once.`)
    const missing = value.filter((id) => !scan.songsById.has(id)).length
    if (missing) {
      const verb = missing === 1 ? 'is' : 'are'
      throw httpError(400, `${missing} of the selected songs ${verb} not in this scan. Scan the folder again.`)
    }
    return value
  }

  // A target inside the scanned folder may not be there yet: it is made
  // under the nearest folder that is, once that is resolved
  async function resolveInsideRoot (target, root) {
    const stat = await lstatOrNull(target)
    if (!stat) return path.join(await resolveInsideRoot(path.dirname(target), root), path.basename(target))
    if (!stat.isDirectory()) throw httpError(400, `${target} is not a folder.`)
    const real = await fs.promises.realpath(target)
    if (!isInside(real, root)) throw httpError(400, `${target} leads outside the scanned folder.`)
    return real
  }

  async function resolveOutside (target) {
    const problem = await checkSaveFolder(target)
    if (problem) throw httpError(400, problem)
    return fs.promises.realpath(target)
  }

  // A move is a rename, which can't cross drives (and is never done as a
  // copy and a delete): say so now rather than fail song by song
  async function requireSameDrive (target, root) {
    const [targetStat, rootStat] = await Promise.all([fs.promises.stat(target), fs.promises.stat(root)])
    if (targetStat.dev !== rootStat.dev) {
      throw httpError(400, 'Songs can only be moved within one drive. Choose Copy to put them on another drive.')
    }
  }

  async function withResolvedTarget (action, options, root) {
    const chosen = options.targetFolder
    if (!TARGET_ACTIONS.has(action) || chosen == null || chosen === '') return options
    const target = path.resolve(chosen)
    const resolved = isInside(target, root) ? await resolveInsideRoot(target, root) : await resolveOutside(target)
    if (options.mode === 'move' && !isInside(resolved, root)) await requireSameDrive(resolved, root)
    return { ...options, targetFolder: resolved }
  }

  async function makePlan (req) {
    const body = requireObject(req.body, 'Send the plan as JSON: { scanId, songIds, action, options }.')
    const scan = findRecord(scans, body.scanId, 'scan', NO_SCAN)
    if (scan.status === 'scanning') throw httpError(409, 'The scan is still running.')
    if (scan.status !== 'done') throw httpError(409, scan.error)
    if (changeLog.isOutOfDate([scan.root], scan.seenSeq)) throw httpError(409, SCAN_CHANGED)
    const songIds = checkedSongIds(body.songIds, scan)
    const problem = planProblem({ action: body.action, options: body.options })
    if (problem) throw httpError(400, problem)

    const options = await withResolvedTarget(body.action, body.options, scan.root)
    const input = { root: scan.root, songs: scan.songs, songIds, action: body.action, options }
    // planned twice: the first plan says where it would write, and what is
    // already there lets the second never aim at a taken name
    const first = buildPlan(input)
    const plan = buildPlan({ ...input, existing: await inspectTargets(first.operations, { log }) })
    const record = plans.add({ id: randomUUID(), plan, seenSeq: scan.seenSeq, createdAt: now(), isApplied: false })

    return {
      planId: record.id,
      operations: plan.operations.map(publicOperation),
      conflicts: plan.conflicts,
      summary: plan.summary,
      targetFolder: plan.targetFolder,
      ...(plan.groups ? { groups: plan.groups } : {})
    }
  }

  // ----- carrying out and undoing -----

  function progressOf (id) {
    return ({ done, total, failure }) => {
      const failed = runs.get(id)?.failed ?? []
      runs.update(id, { done, total, ...(failure ? { failed: [...failed, failure] } : {}) })
    }
  }

  // Never rejects; like runScan, releases the folders as it finishes
  async function carryOut (id, work, release) {
    try {
      const result = await work()
      release()
      runs.update(id, { ...result, finishedAt: now() })
    } catch (err) {
      release()
      log('An organizer run failed:', err)
      runs.update(id, { status: 'error', error: `Stopped: ${readableError(err)}`, finishedAt: now() })
    }
  }

  function newRun (kind, total, journalPath) {
    return runs.add({
      id: randomUUID(),
      kind,
      status: 'running',
      done: 0,
      total,
      failed: [],
      journalPath,
      finishedAt: null
    })
  }

  async function startApply (req) {
    const body = requireObject(req.body, 'Send the plan to carry out as JSON: {"planId": "…"}.')
    const record = findRecord(plans, body.planId, 'plan', NO_PLAN)
    if (record.isApplied) throw httpError(409, 'This plan was already carried out. Scan again to plan more changes.')
    const { plan } = record
    if (changeLog.isOutOfDate(plan.allowedFolders, record.seenSeq)) throw httpError(409, PLAN_CHANGED)
    if (plan.operations.length === 0) throw httpError(400, 'This plan has nothing to do.')
    const release = locks.claim(plan.allowedFolders)
    if (!release) throw httpError(409, BUSY)

    // nothing may change before there is a journal to undo it from
    let journal
    try {
      const { root, action, allowedFolders } = plan
      journal = await createJournal({ root, action, allowedFolders, ...withFs })
    } catch (err) {
      release()
      const folder = path.join(plan.root, JOURNAL_FOLDER)
      const reason = readableError(err)
      throw httpError(500, `Could not write the undo journal in ${folder} (${reason}). Nothing was changed.`)
    }
    plans.update(record.id, { isApplied: true })
    changeLog.record(plan.allowedFolders)
    journals.set(journal.path, plan.allowedFolders)

    const run = newRun('apply', plan.operations.length, journal.path)
    const work = () =>
      applyOperations({
        operations: plan.operations,
        root: plan.root,
        allowedFolders: plan.allowedFolders,
        journal,
        log,
        onProgress: progressOf(run.id),
        ...withFs
      })
    carryOut(run.id, work, release)
    return { applyId: run.id }
  }

  function checkedJournalPath (value) {
    const isJournalPath =
      typeof value === 'string' &&
      value.length <= MAX_PATH_CHARS &&
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      JOURNAL_NAME.test(path.basename(value)) &&
      path.basename(path.dirname(value)) === JOURNAL_FOLDER
    if (!isJournalPath) {
      throw httpError(400, `That is not an organizer journal: a journal-….json file in a ${JOURNAL_FOLDER} folder.`)
    }
    return value
  }

  // The journal itself, reached without links, in the folder it belongs to
  async function realJournalPath (journalPath, realRoot) {
    const stat = await lstatOrNull(journalPath)
    if (!stat) throw httpError(404, `No such journal: ${journalPath}`)
    const real = await fs.promises.realpath(journalPath)
    if (!stat.isFile() || real !== path.join(realRoot, JOURNAL_FOLDER, path.basename(journalPath))) {
      throw httpError(400, 'That journal is reached through a link. Open it from its own folder.')
    }
    return real
  }

  async function readJournalFor (journalPath) {
    try {
      return await readJournal(journalPath)
    } catch (err) {
      if (err.code) throw err // the drive failed: a 500
      throw httpError(400, err.message)
    }
  }

  async function startUndo (req) {
    const body = requireObject(req.body, 'Send the journal to undo as JSON: {"journalPath": "…"}.')
    const journalPath = checkedJournalPath(body.journalPath)
    const root = path.dirname(path.dirname(journalPath))
    const problem = await checkSaveFolder(root)
    if (problem) throw httpError(400, problem)
    const realRoot = await fs.promises.realpath(root)
    const realJournal = await realJournalPath(journalPath, realRoot)
    const journal = await readJournalFor(realJournal)
    if (journal.header.root !== realRoot) {
      throw httpError(400, `This journal belongs to another folder (${journal.header.root}).`)
    }

    const allowedFolders = [...new Set([realRoot, ...(journals.get(realJournal) ?? [])])]
    const release = locks.claim(allowedFolders)
    if (!release) throw httpError(409, BUSY)
    changeLog.record(allowedFolders)

    const todo = journal.entries.filter((entry) => !entry.isUndone).length
    const run = newRun('undo', todo, realJournal)
    const work = () =>
      undoJournal({ journal, journalPath: realJournal, allowedFolders, log, onProgress: progressOf(run.id), ...withFs })
    carryOut(run.id, work, release)
    return { applyId: run.id }
  }

  function getRun (req) {
    const { kind, status, done, total, failed, journalPath, error } = findRecord(runs, req.params.id, 'run', NO_RUN)
    return { kind, status, done, total, failed, journalPath, ...(error ? { error } : {}) }
  }

  // ----- wiring -----

  // Answers with what the handler returns, or { error } for what it throws
  function route (handler) {
    return async (req, res) => {
      try {
        res.json(await handler(req))
      } catch (err) {
        if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message })
        log('An organizer request failed:', err)
        res.status(500).json({ error: `Something went wrong: ${readableError(err)}` })
      }
    }
  }

  const router = express.Router()
  router.use('/organizer', express.json({ limit: BODY_LIMIT }), (req, res, next) => {
    sweep()
    next()
  })
  router.post('/organizer/scan', route(startScan))
  router.get('/organizer/scan/:id', route(getScan))
  router.post('/organizer/plan', route(makePlan))
  router.post('/organizer/apply', route(startApply))
  router.post('/organizer/undo', route(startUndo))
  router.get('/organizer/apply/:id', route(getRun))

  // express.json() turns a body it can't read into an error: answer it in the
  // same { error } shape, not Express's HTML page
  router.use('/organizer', (err, req, res, next) => {
    if (err.status >= 400 && err.status < 500) {
      const error = BODY_ERRORS[err.type] || `Could not read the request: ${err.message}`
      return res.status(err.status).json({ error })
    }
    log('An organizer request failed:', err)
    res.status(500).json({ error: 'Something went wrong.' })
  })
  return router
}

module.exports = { createOrganizerRouter }
