// organizer/routes.js puts the organizer on HTTP: scan a folder, plan a
// change for the selected songs, carry it out, undo it. These tests mount
// the router on an app of their own (an ephemeral port, never the real
// server's) and call it with fetch, as the page would. The songs are plain
// files in temp folders.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const express = require('express')

const { createOrganizerRouter } = require('../organizer/routes')
const { checkSaveFolder } = require('../save-folder')

const POLL_MS = 20
const WAIT_LIMIT_MS = 10_000

function quiet () {}

function makeTempFolder (t, prefix = 'organizer-routes-') {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return folder
}

function writeFile (filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

function makeLibrary (t) {
  const root = makeTempFolder(t)
  writeFile(path.join(root, 'a.mp3'), 'A')
  writeFile(path.join(root, 'sub', 'b.mp3'), 'BB')
  writeFile(path.join(root, 'notes.txt'), 'not a song')
  return root
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// An app with the organizer and two routes of its own after it, to show the
// organizer leaves other requests alone
async function startApp (t, options = {}) {
  const app = express()
  app.use(createOrganizerRouter({ checkSaveFolder, log: quiet, ...options }))
  app.get('/ping', (req, res) => res.send('pong'))
  app.post('/echo', (req, res) => res.json({ body: req.body ?? null }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  async function call (method, url, body) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, body: json, text }
  }

  // poll a scan or a run the way the page does, until it has finished
  async function waitFor (url) {
    const deadline = Date.now() + WAIT_LIMIT_MS
    while (Date.now() < deadline) {
      const reply = await call('GET', url)
      if (reply.status !== 200 || !['scanning', 'running'].includes(reply.body.status)) return reply
      await sleep(POLL_MS)
    }
    throw new Error(`${url} was still going after ${WAIT_LIMIT_MS} ms`)
  }

  const get = (url) => call('GET', url)
  const post = (url, body) => call('POST', url, body)
  return { get, post, waitFor }
}

// a finished scan of folder: { scanId, status, root, songs, … }
async function scanned (api, folder) {
  const { body } = await api.post('/organizer/scan', { folder })
  const finished = await api.waitFor(`/organizer/scan/${body.scanId}`)
  return { scanId: body.scanId, ...finished.body }
}

describe('organizer routes', () => {
  test('scan, plan, apply and undo, start to finish', async (t) => {
    const root = makeLibrary(t)
    const api = await startApp(t)

    const started = await api.post('/organizer/scan', { folder: root })
    assert.equal(started.status, 200)
    assert.match(started.body.scanId, /^[0-9a-f-]{36}$/)
    const scan = await api.waitFor(`/organizer/scan/${started.body.scanId}`)
    assert.equal(scan.body.status, 'done')
    assert.equal(scan.body.root, root)
    assert.equal(scan.body.found, 2)
    assert.equal(scan.body.scanned, 2)
    assert.equal(scan.body.truncated, false)
    assert.deepEqual(scan.body.songs.map((s) => s.relPath), ['a.mp3', 'sub/b.mp3'])

    const planned = await api.post('/organizer/plan', {
      scanId: started.body.scanId,
      songIds: scan.body.songs.map((s) => s.id),
      action: 'playlist',
      options: { name: 'Car', mode: 'move', numberTracks: true, writePlaylist: true }
    })
    assert.equal(planned.status, 200)
    assert.match(planned.body.planId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(planned.body.operations, [
      { kind: 'mkdir', to: path.join(root, 'Car') },
      { kind: 'move', from: path.join(root, 'a.mp3'), to: path.join(root, 'Car', '01 - a.mp3'), songId: scan.body.songs[0].id },
      { kind: 'move', from: path.join(root, 'sub', 'b.mp3'), to: path.join(root, 'Car', '02 - b.mp3'), songId: scan.body.songs[1].id },
      { kind: 'write-m3u', to: path.join(root, 'Car', 'Car.m3u') }
    ])
    assert.deepEqual(planned.body.conflicts, [])
    assert.deepEqual(planned.body.summary, { copies: 0, moves: 2, renames: 0, folders: 1, skipped: 0 })

    const applying = await api.post('/organizer/apply', { planId: planned.body.planId })
    assert.equal(applying.status, 200)
    const applied = await api.waitFor(`/organizer/apply/${applying.body.applyId}`)
    assert.equal(applied.body.status, 'done')
    assert.equal(applied.body.kind, 'apply')
    assert.equal(applied.body.done, 4)
    assert.equal(applied.body.total, 4)
    assert.deepEqual(applied.body.failed, [])
    assert.equal(path.dirname(applied.body.journalPath), path.join(root, '.zipify-organizer'))
    assert.deepEqual(fs.readdirSync(path.join(root, 'Car')).sort(), ['01 - a.mp3', '02 - b.mp3', 'Car.m3u'])
    assert.equal(fs.existsSync(path.join(root, 'a.mp3')), false)

    const undoing = await api.post('/organizer/undo', { journalPath: applied.body.journalPath })
    assert.equal(undoing.status, 200)
    const undone = await api.waitFor(`/organizer/apply/${undoing.body.applyId}`)
    assert.equal(undone.body.status, 'done')
    assert.equal(undone.body.kind, 'undo')
    assert.deepEqual(undone.body.failed, [])
    assert.equal(fs.readFileSync(path.join(root, 'a.mp3'), 'utf8'), 'A')
    assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.mp3'), 'utf8'), 'BB')
    assert.equal(fs.existsSync(path.join(root, 'Car')), false)
  })

  test('sorts into a folder outside the scanned one, and undoes that after the fact', async (t) => {
    const root = makeLibrary(t)
    const backup = makeTempFolder(t, 'organizer-backup-')
    const api = await startApp(t)
    const scan = await scanned(api, root)

    const planned = await api.post('/organizer/plan', {
      scanId: scan.scanId,
      songIds: scan.songs.map((s) => s.id),
      action: 'sort',
      options: { groupBy: 'artist', mode: 'copy', targetFolder: backup }
    })
    assert.equal(planned.status, 200)
    assert.equal(planned.body.targetFolder, backup)
    const applied = await api.waitFor(`/organizer/apply/${(await api.post('/organizer/apply', { planId: planned.body.planId })).body.applyId}`)
    assert.deepEqual(fs.readdirSync(path.join(backup, 'Unknown Artist')).sort(), ['a.mp3', 'b.mp3'])

    const undone = await api.waitFor(`/organizer/apply/${(await api.post('/organizer/undo', { journalPath: applied.body.journalPath })).body.applyId}`)
    assert.deepEqual(undone.body.failed, [])
    assert.deepEqual(fs.readdirSync(backup), [])
  })

  test('refuses bad requests with a readable error', async (t) => {
    const root = makeLibrary(t)
    const api = await startApp(t)
    const scan = await scanned(api, root)
    const ids = scan.songs.map((s) => s.id)
    const sort = { groupBy: 'artist', mode: 'copy' }
    const manyIds = Array.from({ length: 20001 }, (_, i) => i.toString(16).padStart(16, '0'))
    const journals = path.join(root, '.zipify-organizer')

    const cases = [
      ['POST', '/organizer/scan', undefined, 400, /folder/],
      ['POST', '/organizer/scan', {}, 400, /folder/],
      ['POST', '/organizer/scan', { folder: 'Music' }, 400, /full path/],
      ['POST', '/organizer/scan', { folder: 42 }, 400, /folder/],
      ['POST', '/organizer/scan', { folder: root, maxDepth: 9 }, 400, /maxDepth/],
      ['POST', '/organizer/scan', { folder: root, maxDepth: 2.5 }, 400, /maxDepth/],
      ['POST', '/organizer/scan', { folder: path.join(root, 'missing') }, 400, /not found/],
      ['POST', '/organizer/scan', { folder: path.join(root, 'a.mp3') }, 400, /not a folder/],
      ['POST', '/organizer/scan', '{"folder": ', 400, /not valid JSON/],
      ['GET', '/organizer/scan/nope', undefined, 400, /scan id/],
      ['GET', `/organizer/scan/${randomUUID()}`, undefined, 404, /scan/],
      ['POST', '/organizer/plan', { scanId: randomUUID(), songIds: ids, action: 'sort', options: sort }, 404, /scan/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: [], action: 'sort', options: sort }, 400, /at least one song/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: 'all', action: 'sort', options: sort }, 400, /at least one song/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: ['x'], action: 'sort', options: sort }, 400, /song id/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: [ids[0], ids[0]], action: 'sort', options: sort }, 400, /more than once/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: ['0123456789abcdef'], action: 'sort', options: sort }, 400, /not in this scan/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: manyIds, action: 'sort', options: sort }, 400, /at most 20000/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: ids, action: 'shuffle', options: {} }, 400, /Unknown action/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: ids, action: 'rename', options: { pattern: '{mood}' } }, 400, /\{mood\}/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: ids, action: 'sort', options: { ...sort, targetFolder: path.join(root, 'a.mp3') } }, 400, /not a folder/],
      ['POST', '/organizer/plan', { scanId: scan.scanId, songIds: ids, action: 'sort', options: { ...sort, targetFolder: path.join(os.tmpdir(), `organizer-missing-${randomUUID()}`) } }, 400, /not found/],
      ['POST', '/organizer/apply', { planId: 'x' }, 400, /plan id/],
      ['POST', '/organizer/apply', { planId: randomUUID() }, 404, /plan/],
      ['GET', `/organizer/apply/${randomUUID()}`, undefined, 404, /run/],
      ['POST', '/organizer/undo', { journalPath: '/etc/passwd' }, 400, /journal/],
      ['POST', '/organizer/undo', { journalPath: 'journal-1.json' }, 400, /journal/],
      ['POST', '/organizer/undo', { journalPath: path.join(journals, 'journal-2026-01-01T00-00-00-000Z.json') }, 404, /journal/],
      ['POST', '/organizer/undo', { journalPath: `${root}/sub/../.zipify-organizer/journal-1.json` }, 400, /journal/]
    ]

    for (const [method, url, body, status, message] of cases) {
      const reply = await (method === 'GET' ? api.get(url) : api.post(url, body))
      assert.equal(reply.status, status, `${method} ${url} ${JSON.stringify(body)?.slice(0, 120)}: ${reply.text}`)
      assert.match(reply.body?.error ?? '', message, `${method} ${url}: ${reply.text}`)
    }
  })

  test('refuses a damaged journal, or one belonging to another folder', async (t) => {
    const root = makeLibrary(t)
    const other = makeTempFolder(t)
    const api = await startApp(t)
    const damaged = writeFile(path.join(root, '.zipify-organizer', 'journal-1.json'), 'garbage\nmore\n')
    const foreign = writeFile(
      path.join(root, '.zipify-organizer', 'journal-2.json'),
      `${JSON.stringify({ type: 'header', version: 1, root: other, action: 'sort', allowedFolders: [other] })}\n`
    )

    const one = await api.post('/organizer/undo', { journalPath: damaged })
    const two = await api.post('/organizer/undo', { journalPath: foreign })

    assert.equal(one.status, 400)
    assert.match(one.body.error, /damaged/)
    assert.equal(two.status, 400)
    assert.match(two.body.error, /another folder/)
  })

  test('one scan or change at a time per folder, and a folder inside it counts', async (t) => {
    const root = makeLibrary(t)
    const elsewhere = makeLibrary(t)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const readTags = async () => {
      await gate
      return {}
    }
    const api = await startApp(t, { readTags })

    const first = await api.post('/organizer/scan', { folder: root })
    const again = await api.post('/organizer/scan', { folder: root })
    const inside = await api.post('/organizer/scan', { folder: path.join(root, 'sub') })
    const other = await api.post('/organizer/scan', { folder: elsewhere })
    const scanning = await api.get(`/organizer/scan/${first.body.scanId}`)
    release()

    assert.equal(first.status, 200)
    assert.equal(again.status, 409)
    assert.match(again.body.error, /busy/)
    assert.equal(inside.status, 409)
    assert.equal(other.status, 200)
    assert.equal(scanning.body.status, 'scanning')
    assert.equal(scanning.body.songs, undefined)
    assert.equal((await api.waitFor(`/organizer/scan/${first.body.scanId}`)).body.status, 'done')
    assert.equal((await api.post('/organizer/scan', { folder: root })).status, 200)
  })

  test('a plan is carried out once, and only while its folder is unchanged', async (t) => {
    const root = makeLibrary(t)
    const api = await startApp(t)
    const scan = await scanned(api, root)
    const request = {
      scanId: scan.scanId,
      songIds: scan.songs.map((s) => s.id),
      action: 'sort',
      options: { groupBy: 'artist', mode: 'move' }
    }
    const first = await api.post('/organizer/plan', request)
    const second = await api.post('/organizer/plan', { ...request, options: { groupBy: 'genre', mode: 'move' } })

    const run = await api.post('/organizer/apply', { planId: first.body.planId })
    await api.waitFor(`/organizer/apply/${run.body.applyId}`)
    const twice = await api.post('/organizer/apply', { planId: first.body.planId })
    const stale = await api.post('/organizer/apply', { planId: second.body.planId })
    const fromOldScan = await api.post('/organizer/plan', request)

    assert.equal(twice.status, 409)
    assert.match(twice.body.error, /already/)
    assert.equal(stale.status, 409)
    assert.match(stale.body.error, /changed/)
    assert.equal(fromOldScan.status, 409)
    assert.match(fromOldScan.body.error, /changed/)
  })

  test('a plan with nothing to do is not carried out', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'Unknown Artist', 'a.mp3'), 'A')
    const api = await startApp(t)
    const scan = await scanned(api, root)
    const planned = await api.post('/organizer/plan', {
      scanId: scan.scanId,
      songIds: scan.songs.map((s) => s.id),
      action: 'sort',
      options: { groupBy: 'artist', mode: 'move', targetFolder: root }
    })

    assert.deepEqual(planned.body.conflicts, [{ songId: scan.songs[0].id, reason: 'Already in place' }])
    const run = await api.post('/organizer/apply', { planId: planned.body.planId })
    assert.equal(run.status, 400)
    assert.match(run.body.error, /nothing to do/)
  })

  test('scans, plans and runs are forgotten 30 minutes after they finish', async (t) => {
    const root = makeLibrary(t)
    let clock = 1_000_000
    const api = await startApp(t, { now: () => clock })
    const scan = await scanned(api, root)
    const planned = await api.post('/organizer/plan', {
      scanId: scan.scanId,
      songIds: scan.songs.map((s) => s.id),
      action: 'dedupe',
      options: { keep: 'first' }
    })
    assert.equal(planned.status, 200)
    assert.deepEqual(planned.body.groups, [])

    clock += 30 * 60 * 1000 + 1
    assert.equal((await api.get(`/organizer/scan/${scan.scanId}`)).status, 404)
    assert.equal((await api.post('/organizer/apply', { planId: planned.body.planId })).status, 404)
  })

  test('leaves the rest of the server alone', async (t) => {
    const api = await startApp(t)

    assert.equal((await api.get('/ping')).text, 'pong')
    assert.deepEqual((await api.post('/echo', { a: 1 })).body, { body: null })
  })
})
