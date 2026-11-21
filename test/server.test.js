const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

// server.js works relative to the current directory (uploads/, mp3s_*/) and
// clears old mp3s_* folders on load, so run it somewhere disposable.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipify-test-'))
process.chdir(workDir)
const {
  app,
  services,
  estimateBytesNeeded,
  searchVideos,
  searchItunes,
  resetItunesBackoff,
  listSongFiles,
  makeFileBaseFromTitle,
  renameToUniqueTitle,
  runYtDlp,
  shortErrorReason,
  ytDlpDownloadFlags,
  isLeftoverWorkFolder
} = require('../server')
const {
  makeUniqueFolder,
  openFolder,
  removeMacMetadataFiles,
  removeMacMetadataFor
} = require('../save-folder')
const { normalizeVideo } = require('../matching')

// Every run keeps the Mac awake and retries failed downloads unless told
// otherwise. In tests nothing may spawn caffeinate or sit out a real retry
// wait, so stand-ins are in place from the start (a test can swap its own in
// with withServices).
services.keepAwake = { acquire: () => () => {}, isActive: () => false }
services.retryDelaysMs = [0]

const POLL_INTERVAL_MS = 200
// a job waits for the yt-dlp update check that runs on boot
const POLL_TIMEOUT_MS = 90_000
const CLEANUP_TIMEOUT_MS = 5_000
const MB = 1024 * 1024

// a CSV with no title/artist columns: every row is skipped, so the job fails
// without searching or downloading anything
const CSV_WITHOUT_SONGS = 'foo,bar\n1,2\n'

let server
let baseUrl

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  baseUrl = `http://localhost:${server.address().port}`
})

after(() => {
  server.closeAllConnections()
  server.close()
  process.chdir(os.tmpdir())
  fs.rmSync(workDir, { recursive: true, force: true })
})

async function uploadCsv (csvText, fields = {}) {
  const form = new FormData()
  form.append('csv', new Blob([csvText], { type: 'text/csv' }), 'My Playlist.csv')
  form.append('quality', '128')
  for (const [name, value] of Object.entries(fields)) form.append(name, value)

  const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form })
  return { status: res.status, body: await res.json() }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// poll /progress the way the page does, until the job leaves "running"
async function waitForJob (jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/progress?job=${encodeURIComponent(jobId)}`)
    if (res.status !== 200) return { status: res.status, body: null }
    const body = await res.json()
    if (body.status !== 'running') return { status: res.status, body }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`job ${jobId} was still running after ${POLL_TIMEOUT_MS} ms`)
}

// cleanup runs in the background after a job finishes, so give it a moment
async function waitUntil (check) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS
  while (!check() && Date.now() < deadline) await sleep(50)
}

function tempFolders () {
  return fs.readdirSync(workDir).filter((name) => name.startsWith('mp3s_'))
}

// stands in for a pen drive
function makeDriveFolder () {
  return fs.mkdtempSync(path.join(workDir, 'drive-'))
}

// --- ZIP mode (no save folder) ---

test('an empty CSV is refused', async () => {
  const upload = await uploadCsv('Track Name,Artist Name(s)\n')

  assert.equal(upload.status, 400)
  assert.equal(upload.body.error, 'The CSV had no rows.')
})

test('a failed job stays readable so the page can show why it failed', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS)
  assert.equal(upload.status, 200)

  const job = await waitForJob(upload.body.jobId)

  assert.equal(job.status, 200, 'polling a failed job must not 404')
  assert.equal(job.body.status, 'error')
  assert.equal(job.body.error, 'No songs could be downloaded.')
  assert.deepEqual(job.body.failures, ['Row with no title/artist'])
})

test('a failed job still deletes its temp folder', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS)
  await waitForJob(upload.body.jobId)

  await waitUntil(() => tempFolders().length === 0)

  assert.deepEqual(tempFolders(), [])
})

// --- save to a folder ---

test('a save folder has to be a full path', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: 'Music' })

  assert.equal(upload.status, 400)
  assert.match(upload.body.error, /full path/)
})

test('a save folder that does not exist is refused', async () => {
  const missing = path.join(workDir, 'unplugged-drive')

  const upload = await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: missing })

  assert.equal(upload.status, 400)
  assert.match(upload.body.error, /not found/)
})

test('a save folder that is really a file is refused', async () => {
  const file = path.join(makeDriveFolder(), 'notes.txt')
  fs.writeFileSync(file, 'hi')

  const upload = await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: file })

  assert.equal(upload.status, 400)
  assert.match(upload.body.error, /not a folder/)
})

test('a refused save folder does not start a job or leave temp files', async () => {
  const before = tempFolders()

  await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: 'Music' })

  assert.deepEqual(tempFolders(), before)
})

test('a failed save-to-folder job reports its error and leaves the drive as it was', async () => {
  const drive = makeDriveFolder()

  const upload = await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: drive })
  assert.equal(upload.status, 200)
  const job = await waitForJob(upload.body.jobId)

  assert.equal(job.body.status, 'error')
  assert.equal(job.body.error, 'No songs could be downloaded.')
  assert.equal(job.body.saveFolder, path.join(drive, 'My Playlist'), 'named after the CSV')
  await waitUntil(() => fs.readdirSync(drive).length === 0)
  assert.deepEqual(fs.readdirSync(drive), [], 'empty playlist folder should be removed')
  assert.deepEqual(tempFolders(), [], 'nothing should be written next to the server')
})

test('a new playlist folder never reuses an existing one', async () => {
  const drive = makeDriveFolder()

  const first = await makeUniqueFolder(drive, 'Road Trip')
  const second = await makeUniqueFolder(drive, 'Road Trip')

  assert.equal(path.basename(first), 'Road Trip')
  assert.equal(path.basename(second), 'Road Trip (2)')
  assert.ok(fs.statSync(second).isDirectory())
})

test('saving to a folder needs half the space of a ZIP download', () => {
  assert.equal(estimateBytesNeeded(10, { toFolder: false }), 10 * 10 * MB * 2)
  assert.equal(estimateBytesNeeded(10, { toFolder: true }), 10 * 10 * MB)
})

test('GET /drives lists connected external drives, not the main disk', async () => {
  const res = await fetch(`${baseUrl}/drives`)
  const drives = await res.json()

  assert.equal(res.status, 200)
  assert.ok(Array.isArray(drives))
  const rootDevice = fs.statSync('/').dev
  for (const drive of drives) {
    assert.equal(typeof drive.path, 'string')
    assert.equal(typeof drive.name, 'string')
    assert.equal(typeof drive.freeBytes, 'number')
    assert.notEqual(fs.statSync(drive.path).dev, rootDevice, `${drive.path} is the main disk`)
  }
})

// --- requests from other websites ---

// fetch won't let a test forge the Host header, so send the form by hand
async function postUpload (headers) {
  const form = new FormData()
  form.append('csv', new Blob([CSV_WITHOUT_SONGS], { type: 'text/csv' }), 'x.csv')
  form.append('saveTo', makeDriveFolder())
  const request = new Request(`${baseUrl}/upload`, { method: 'POST', body: form })
  const body = Buffer.from(await request.arrayBuffer())

  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/upload`, {
      method: 'POST',
      headers: {
        'content-type': request.headers.get('content-type'),
        'content-length': body.length,
        ...headers
      }
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('another website cannot start a job', async () => {
  const res = await postUpload({ origin: 'https://evil.example' })

  assert.equal(res.status, 403)
})

test('a website that points its own name at this computer cannot start a job', async () => {
  const port = server.address().port
  const res = await postUpload({
    host: `evil.example:${port}`,
    origin: `http://evil.example:${port}`
  })

  assert.equal(res.status, 403)
})

test('the ZipifyTunes page itself can start a job', async () => {
  const res = await postUpload({ origin: baseUrl })

  assert.equal(res.status, 200)
  await waitForJob(JSON.parse(res.text).jobId) // let it finish before the next test
})

// --- running yt-dlp ---

test('yt-dlp runs even when the app lives in a folder with spaces', async () => {
  // youtube-dl-exec's own runner split the binary path at a space (as in
  // "Application Support") and failed every download, so check a path with
  // spaces on any machine, not only where this checkout happens to live
  const folder = path.join(fs.mkdtempSync(path.join(workDir, 'app-')), 'folder with spaces')
  fs.mkdirSync(folder)
  const binary = path.join(folder, 'yt-dlp')
  fs.writeFileSync(binary, '#!/bin/sh\necho 2099.01.01\n', { mode: 0o755 })

  assert.equal(await runYtDlp(['--version'], { binary }), '2099.01.01')
  assert.match(await runYtDlp(['--version']), /^\d{4}\.\d{2}\.\d{2}/, 'the bundled yt-dlp runs too')
})

test('a yt-dlp failure keeps its error output for the failure list', async () => {
  await assert.rejects(runYtDlp(['--no-such-flag']), (err) => {
    assert.match(err.stderr, /no such option/)
    return true
  })
})

// --- FAT32 pen drives written from a Mac ---

// macOS can't store file metadata on FAT32, so it writes a hidden "._<name>"
// file next to each real one, e.g. "._Song.mp3"
function makeFolderWithMacMetadata () {
  const folder = makeDriveFolder()
  fs.writeFileSync(path.join(folder, 'Song.mp3'), 'audio')
  fs.writeFileSync(path.join(folder, '._Song.mp3'), 'mac metadata')
  fs.writeFileSync(path.join(folder, 'cover.jpg'), 'image')
  return folder
}

test('song counts ignore the hidden ._ files macOS adds on FAT32 drives', () => {
  const folder = makeFolderWithMacMetadata()

  assert.deepEqual(listSongFiles(folder), ['Song.mp3'])
})

test('a saved playlist folder is cleared of macOS ._ files', async () => {
  const folder = makeFolderWithMacMetadata()

  await removeMacMetadataFiles(folder)

  assert.deepEqual(fs.readdirSync(folder).sort(), ['Song.mp3', 'cover.jpg'])
})

// --- live tracker ---

async function progressOf (jobId, after) {
  const query = after === undefined ? '' : `&after=${after}`
  const res = await fetch(`${baseUrl}/progress?job=${encodeURIComponent(jobId)}${query}`)
  return res.json()
}

test('the tracker logs each song as it finishes, and only new ones on request', async () => {
  const upload = await uploadCsv('foo,bar\n1,2\n3,4\n')
  await waitForJob(upload.body.jobId)

  const all = await progressOf(upload.body.jobId)
  const newer = await progressOf(upload.body.jobId, 1)

  assert.deepEqual(all.events, [
    { seq: 1, text: '✗ Row with no title/artist' },
    { seq: 2, text: '✗ Row with no title/artist' }
  ])
  assert.deepEqual(newer.events, [{ seq: 2, text: '✗ Row with no title/artist' }])
  assert.equal(all.done, 2, 'each skipped row is counted once, not twice')
})

test('the tracker reports sizes and times alongside the song count', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS)
  const job = (await waitForJob(upload.body.jobId)).body

  assert.equal(job.savedBytes, 0)
  assert.equal(job.estimatedTotalBytes, null, 'nothing saved, so no size estimate')
  assert.equal(typeof job.elapsedMs, 'number')
  assert.ok('etaMs' in job)
  assert.deepEqual(job.active, [], 'no song in progress once the job is over')
})

// --- fixes from code review ---

test('a stray HOST variable does not open the server to other names', async () => {
  // many shells and tools set HOST to the machine name without anyone opting in
  process.env.HOST = 'my-macbook'
  try {
    const port = server.address().port
    const res = await postUpload({
      host: `evil.example:${port}`,
      origin: `http://evil.example:${port}`
    })

    assert.equal(res.status, 403)
  } finally {
    delete process.env.HOST
  }
})

test('ZIPIFY_HOST lets that one address in, and nothing else', async () => {
  process.env.ZIPIFY_HOST = '192.168.1.20'
  try {
    const port = server.address().port
    const lan = `192.168.1.20:${port}`

    const allowed = await postUpload({ host: lan, origin: `http://${lan}` })
    const other = await postUpload({
      host: `evil.example:${port}`,
      origin: `http://evil.example:${port}`
    })

    assert.equal(allowed.status, 200)
    assert.equal(other.status, 403)
    await waitForJob(JSON.parse(allowed.text).jobId)
  } finally {
    delete process.env.ZIPIFY_HOST
  }
})

test('job ids are random, not a guessable timestamp', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS)

  assert.match(upload.body.jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  await waitForJob(upload.body.jobId)
})

test('song file names never start with a dot (hidden, or mistaken for ._ files)', () => {
  assert.equal(makeFileBaseFromTitle('.38 Special'), '38 Special')
  assert.equal(makeFileBaseFromTitle('._Intro'), '_Intro')
  assert.equal(makeFileBaseFromTitle('...Ready For It?'), 'Ready For It')
})

// --- parallel downloads, pause / stop, skipping songs already saved ---

async function control (jobId, action) {
  const res = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/${action}`, {
    method: 'POST'
  })
  return { status: res.status, body: await res.json() }
}

test('parallel downloads are limited to 1–20, defaulting to 3', async () => {
  const twelve = await uploadCsv(CSV_WITHOUT_SONGS, { parallel: '12' })
  const tooMany = await uploadCsv(CSV_WITHOUT_SONGS, { parallel: '50' })
  const junk = await uploadCsv(CSV_WITHOUT_SONGS, { parallel: 'lots' })

  assert.equal((await waitForJob(twelve.body.jobId)).body.parallel, 12)
  assert.equal((await waitForJob(tooMany.body.jobId)).body.parallel, 20)
  assert.equal((await waitForJob(junk.body.jobId)).body.parallel, 3)
})

test('pause, resume and stop only apply to a job that is still running', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS)
  await waitForJob(upload.body.jobId)

  assert.equal((await control('no-such-job', 'pause')).status, 404)
  assert.equal((await control(upload.body.jobId, 'explode')).status, 400)
  assert.equal((await control(upload.body.jobId, 'pause')).status, 409)
})

test('two songs with the same title finishing together both keep their file', async () => {
  const folder = makeDriveFolder()
  const first = path.join(folder, 'track_1.mp3')
  const second = path.join(folder, 'track_2.mp3')
  fs.writeFileSync(first, 'A')
  fs.writeFileSync(second, 'B')
  const reserved = new Set()

  const names = await Promise.all([
    renameToUniqueTitle(first, folder, 'Song', reserved),
    renameToUniqueTitle(second, folder, 'Song', reserved)
  ])

  assert.deepEqual(names.map((n) => path.basename(n)).sort(), ['Song (2).mp3', 'Song.mp3'])
  assert.deepEqual(fs.readdirSync(folder).sort(), ['Song (2).mp3', 'Song.mp3'])
})

test('re-running a playlist reuses its folder', async () => {
  const drive = makeDriveFolder()

  const first = await openFolder(drive, 'Road Trip')
  const again = await openFolder(drive, 'Road Trip')

  assert.equal(again, first)
  assert.deepEqual(fs.readdirSync(drive), ['Road Trip'])
})

test('a file in the way of the playlist folder is reported', async () => {
  const drive = makeDriveFolder()
  fs.writeFileSync(path.join(drive, 'Road Trip'), 'not a folder')

  await assert.rejects(openFolder(drive, 'Road Trip'), /not a folder/)
})

test('with skipExisting, songs already in the playlist folder are not fetched again', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  fs.mkdirSync(playlist)
  fs.writeFileSync(path.join(playlist, 'Song A.mp3'), 'audio from an earlier run')

  const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\n', {
    saveTo: drive,
    skipExisting: '1'
  })
  const job = (await waitForJob(upload.body.jobId)).body

  assert.equal(job.status, 'saved')
  assert.equal(job.saveFolder, playlist, 'reuses the folder, no "My Playlist (2)"')
  assert.equal(job.skippedCount, 1)
  assert.equal(job.savedCount, 0)
  assert.deepEqual(job.events.map((e) => e.text), ['↷ Song A — already in the folder'])
  await waitUntil(() => fs.readdirSync(playlist).length === 2)
  assert.deepEqual(
    fs.readdirSync(playlist).sort(),
    ['My Playlist.m3u', 'Song A.mp3'],
    'work folder cleaned up; the playlist file (on by default) lists the skipped song'
  )
})

// --- finding songs, stopping downloads, macOS leftovers next to the folder ---

const NO_RESULTS = { videos: [] }

test('a song yt-search misses is retried, then found with yt-dlp', async () => {
  let searches = 0
  const videos = await searchVideos('Raanjhanaa A.R. Rahman', {
    search: async () => {
      searches++
      return NO_RESULTS
    },
    // one "id<TAB>title<TAB>channel<TAB>duration" line per result
    searchWithYtDlp: async () =>
      'aBcDeFgHiJk\tRaanjhanaa | A. R. Rahman\tT-Series\t245\n' +
      'PLaBcDeFgHiJkLmNoPqRsTuVwXyZ012345\tA playlist, not a video\tNA\tNA\n'
  })

  assert.equal(searches, 2)
  assert.deepEqual(videos, [
    {
      videoId: 'aBcDeFgHiJk',
      url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk',
      title: 'Raanjhanaa | A. R. Rahman',
      channel: 'T-Series',
      durationSec: 245,
      views: null,
      thumbnail: 'https://i.ytimg.com/vi/aBcDeFgHiJk/hqdefault.jpg'
    }
  ])
})

test('yt-search results are used as they are, without asking yt-dlp', async () => {
  const hit = {
    videoId: 'abcdefghijk',
    url: 'https://youtube.com/watch?v=abcdefghijk',
    title: 'Song',
    author: { name: 'Artist' },
    seconds: 200
  }
  let usedYtDlp = false

  const videos = await searchVideos('Song Artist', {
    search: async () => ({ videos: [hit] }),
    searchWithYtDlp: async () => {
      usedYtDlp = true
      return ''
    }
  })

  assert.deepEqual(videos, [normalizeVideo(hit)])
  assert.equal(usedYtDlp, false)
})

test('a song nobody can find comes back as an empty list', async () => {
  const videos = await searchVideos('No Such Song', {
    search: async () => {
      throw new Error('YouTube said no')
    },
    searchWithYtDlp: async () => {
      throw new Error('yt-dlp said no too')
    }
  })

  assert.deepEqual(videos, [])
})

test("Stop's signal kills yt-dlp", async () => {
  const stop = new AbortController()
  stop.abort()

  await assert.rejects(runYtDlp(['--version'], { signal: stop.signal }), { name: 'AbortError' })
})

test("the playlist folder's own ._ twin next to it is cleared too", async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'Road Trip')
  fs.mkdirSync(playlist)
  fs.writeFileSync(path.join(playlist, '._Song.mp3'), 'mac metadata')
  fs.writeFileSync(path.join(drive, '._Road Trip'), 'mac metadata')
  fs.writeFileSync(path.join(drive, '._Other Folder'), 'not ours')

  await removeMacMetadataFor(playlist)

  assert.deepEqual(fs.readdirSync(playlist), [])
  assert.deepEqual(fs.readdirSync(drive).sort(), ['._Other Folder', 'Road Trip'])
})

// --- review list: songs without a sure match, other versions, picked songs ---

const CANDIDATE_KEYS = [
  'channel', 'durationSec', 'label', 'score', 'thumbnail', 'title', 'url', 'variant', 'videoId', 'views'
]
const REVIEW_ITEM_KEYS = [
  'album', 'artist', 'candidates', 'durationSec', 'genre', 'number', 'reason', 'title', 'year'
]
const NO_EXACT_MATCH_MESSAGE =
  'None of the songs had an exact match. Pick the right versions in the review list.'
const PICKED_SONG = { title: 'Song A', artist: 'Someone', videoId: 'abcdefghijk' }

// a search result the way searchVideos hands it over
function searchResult (videoId, title, extra = {}) {
  return normalizeVideo({ videoId, title, channel: 'Some Channel', durationSec: 240, ...extra })
}

// Stand in for YouTube and iTunes during one test, so it runs offline, then
// put the real calls back
async function withServices (stubs, run) {
  const real = { ...services }
  Object.assign(services, stubs)
  try {
    return await run()
  } finally {
    Object.assign(services, real)
  }
}

// run a CSV with YouTube stood in for, and return the finished job
function runCsvWith (stubs, csvText) {
  return withServices(stubs, async () => {
    const upload = await uploadCsv(csvText)
    return (await waitForJob(upload.body.jobId)).body
  })
}

async function postJson (route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

// stands in for yt-dlp: a download that only ends when Stop kills it
function downloadUntilStopped (url, outputTemplate, quality, { signal }) {
  return new Promise((resolve, reject) => {
    const stopped = () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }))
    if (signal.aborted) return stopped()
    signal.addEventListener('abort', stopped, { once: true })
  })
}

// About a second of silent MP3 (MPEG-1 Layer III frames, 128 kbps, 44.1 kHz,
// mono): enough for ffmpeg to tag, so a "download" can be faked offline
const MP3_FRAME_BYTES = 417
const MP3_FRAME_COUNT = 40

function silentMp3 () {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0xc0])
  const frame = Buffer.concat([header, Buffer.alloc(MP3_FRAME_BYTES - header.length)])
  return Buffer.concat(Array(MP3_FRAME_COUNT).fill(frame))
}

test('a song whose search only finds a different song is listed for review, not downloaded', async () => {
  let downloads = 0
  const job = await runCsvWith(
    {
      searchVideos: async () => [searchResult('teraBan1234', 'Tera Ban Jaunga | Kabir Singh')],
      downloadMP3: async () => {
        downloads++
      }
    },
    'Track Name,Artist\nTum Hi Ho,Arijit Singh\n'
  )

  assert.equal(downloads, 0)
  assert.equal(job.status, 'error')
  assert.equal(job.error, NO_EXACT_MATCH_MESSAGE)
  assert.equal(job.done, 1, 'a song listed for review still counts as done')
  assert.equal(job.reviewCount, 1)
  assert.deepEqual(Object.keys(job.reviews[0]).sort(), REVIEW_ITEM_KEYS)
  assert.equal(job.reviews[0].number, 1)
  assert.equal(job.reviews[0].title, 'Tum Hi Ho')
  assert.equal(job.reviews[0].artist, 'Arijit Singh')
  assert.equal(job.reviews[0].reason, 'No exact match on YouTube')
  assert.equal(job.reviews[0].candidates[0].videoId, 'teraBan1234')
  assert.equal(job.reviews[0].candidates[0].label, 'Unlikely')
  assert.deepEqual(job.events.map((e) => e.text), [
    '? Tum Hi Ho — Arijit Singh: no exact match on YouTube'
  ])
})

test('a song the search cannot find at all is listed as not found on YouTube', async () => {
  const queries = []
  const job = await runCsvWith(
    {
      searchVideos: async (query) => {
        queries.push(query)
        return []
      }
    },
    'Track Name,Artist\nSong A,Someone\n'
  )

  assert.deepEqual(queries, ['Song A Someone'])
  assert.equal(job.reviews[0].reason, 'Not found on YouTube')
  assert.deepEqual(job.reviews[0].candidates, [])
  assert.deepEqual(job.events.map((e) => e.text), ['? Song A — Someone: not found on YouTube'])
  assert.equal(job.error, NO_EXACT_MATCH_MESSAGE)
})

test('Exportify columns give the song its artist and length', async () => {
  const job = await runCsvWith(
    { searchVideos: async () => [] },
    'Track Name,Artist Name(s),Duration (ms)\nSong A,"Someone, Someone Else",215000\n'
  )

  assert.equal(job.reviews[0].artist, 'Someone, Someone Else')
  assert.equal(job.reviews[0].durationSec, 215)
})

test('a song whose download fails is listed for review with the other results', async () => {
  const job = await runCsvWith(
    {
      searchVideos: async () => [
        searchResult('rightSong01', 'Song A | Someone'),
        searchResult('liveSong001', 'Song A (Live) | Someone')
      ],
      downloadMP3: async () => {
        throw Object.assign(new Error('yt-dlp failed'), {
          stderr: 'ERROR: [youtube] rightSong01: HTTP Error 403: Forbidden\n'
        })
      }
    },
    'Track Name,Artist\nSong A,Someone\n'
  )

  assert.equal(job.reviews[0].reason, 'Download failed: HTTP Error 403: Forbidden')
  assert.deepEqual(
    job.reviews[0].candidates.map((c) => c.videoId),
    ['rightSong01', 'liveSong001'],
    'the video that failed comes first, to retry it (e.g. after turning on YouTube sign-in)'
  )
  assert.deepEqual(
    job.events.map((e) => e.text),
    ['✗ Song A — Someone — HTTP Error 403: Forbidden'],
    'just the ✗ line, no extra ? line'
  )
  assert.equal(job.error, 'No songs could be downloaded.', 'the song had a match, its download failed')
})

test('POST /alternatives searches a few ways and ranks the exact title first', async () => {
  const queries = []
  const res = await withServices(
    {
      searchVideos: async (query) => {
        queries.push(query)
        return [
          searchResult('otherSong01', 'Something Else | Arijit Singh'),
          searchResult('tumHiHo0001', 'Tum Hi Ho | Arijit Singh | Aashiqui 2')
        ]
      }
    },
    () =>
      postJson('/alternatives', {
        title: 'Tum Hi Ho',
        artist: 'Arijit Singh',
        album: 'Aashiqui 2',
        durationSec: 240
      })
  )

  assert.equal(res.status, 200)
  assert.deepEqual(
    res.body.candidates.map((c) => c.videoId),
    ['tumHiHo0001', 'otherSong01'],
    'best first, each video once'
  )
  assert.equal(queries.length, 4)
  assert.deepEqual(Object.keys(res.body.candidates[0]).sort(), CANDIDATE_KEYS)
})

test('POST /alternatives needs a title', async () => {
  const res = await postJson('/alternatives', { artist: 'Arijit Singh' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /title/)
})

test('a request body that is not JSON gets a readable error', async () => {
  const res = await postJson('/picks', '{"name": ')

  assert.equal(res.status, 400)
  assert.match(res.body.error, /not valid JSON/)
})

test('POST /picks refuses a bad video id, an empty list and a missing save folder', async () => {
  const badId = await postJson('/picks', {
    name: 'Mix',
    songs: [{ ...PICKED_SONG, videoId: 'https://evil.example' }]
  })
  const noSongs = await postJson('/picks', { name: 'Mix', songs: [] })
  const unplugged = await postJson('/picks', {
    name: 'Mix',
    saveFolder: path.join(workDir, 'unplugged-drive'),
    songs: [PICKED_SONG]
  })

  assert.equal(badId.status, 400)
  assert.match(badId.body.error, /video id/)
  assert.equal(noSongs.status, 400)
  assert.match(noSongs.body.error, /at least one song/)
  assert.equal(unplugged.status, 400)
  assert.match(unplugged.body.error, /not found/)
})

test('picked songs download the chosen video, with no search, into "<name> (picked)"', async () => {
  const downloaded = []
  let searched = false
  const job = await withServices(
    {
      searchVideos: async () => {
        searched = true
        return []
      },
      downloadMP3: async (url) => {
        downloaded.push(url)
        throw new Error('ERROR: Video unavailable')
      }
    },
    async () => {
      const res = await postJson('/picks', { name: 'Road Trip', songs: [PICKED_SONG] })
      return (await waitForJob(res.body.jobId)).body
    }
  )

  assert.equal(searched, false)
  assert.deepEqual(downloaded, ['https://www.youtube.com/watch?v=abcdefghijk'])
  assert.equal(job.name, 'Road Trip (picked)')
  assert.equal(job.saveFolder, null, 'no save folder, so a ZIP')
  assert.equal(job.reviews[0].reason, 'Download failed: Video unavailable')
  assert.deepEqual(job.reviews[0].candidates.map((c) => c.videoId), [PICKED_SONG.videoId], 'the picked video is offered again, to retry it')
})

test('picks saved to a folder go straight into it, and Stop leaves the folder there', async () => {
  const drive = makeDriveFolder()

  const { started, running, stopped, job } = await withServices(
    { downloadMP3: downloadUntilStopped },
    async () => {
      const started = await postJson('/picks', {
        name: 'Road Trip',
        saveFolder: drive,
        songs: [PICKED_SONG]
      })
      const running = await progressOf(started.body.jobId)
      const stopped = await control(started.body.jobId, 'stop')
      const job = (await waitForJob(started.body.jobId)).body
      return { started, running, stopped, job }
    }
  )

  assert.equal(started.status, 200)
  assert.equal(running.status, 'running')
  assert.equal(running.reviewCount, 0)
  assert.equal('reviews' in running, false, 'the review list only comes once the run is over')
  assert.equal(stopped.status, 200)
  assert.equal(job.saveFolder, drive, 'the picked folder itself')
  assert.equal(job.error, 'Stopped before any song was saved.')
  await waitUntil(() => !fs.existsSync(drive) || fs.readdirSync(drive).length === 0)
  assert.ok(fs.existsSync(drive), 'a picked folder is never removed, even when empty')
  assert.deepEqual(fs.readdirSync(drive), [], 'no new folder inside it, and no work files left')
})

test('picks saved to a folder land next to what is already there', async () => {
  const drive = makeDriveFolder()
  fs.writeFileSync(path.join(drive, 'Old Song.mp3'), 'already here')

  const job = await withServices(
    {
      downloadMP3: async (url, outputTemplate, quality, options) => {
        const mp3 = path.join(options.cwd, outputTemplate.replace('%(ext)s', 'mp3'))
        await fs.promises.writeFile(mp3, silentMp3())
      },
      fetchAlbumArt: async () => null
    },
    async () => {
      const res = await postJson('/picks', { name: 'Road Trip', saveFolder: drive, songs: [PICKED_SONG] })
      return (await waitForJob(res.body.jobId)).body
    }
  )

  assert.equal(job.status, 'saved')
  assert.equal(job.saveFolder, drive)
  assert.equal(job.downloaded, 1, 'only the song this run saved, not what was there before')
  assert.deepEqual(fs.readdirSync(drive).sort(), ['Old Song.mp3', 'Song A.mp3'])
  assert.equal(fs.readFileSync(path.join(drive, 'Old Song.mp3'), 'utf8'), 'already here')
})

// --- album art ---

test('once iTunes refuses lookups (403 or 429), it is left alone for a minute', async () => {
  for (const status of [403, 429]) {
    resetItunesBackoff()
    let calls = 0
    let clock = 1_000_000
    const now = () => clock
    const refused = async () => {
      calls++
      return { ok: false, status, json: async () => ({}) }
    }
    const answered = async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({ results: [{ trackName: 'Song A' }] }) }
    }

    try {
      assert.deepEqual(await searchItunes('Song A', { fetchFn: refused, now }), [])
      clock += 59_000
      assert.deepEqual(await searchItunes('Song A', { fetchFn: answered, now }), [], `still paused after ${status}`)
      assert.equal(calls, 1, 'iTunes is not asked while paused')

      clock += 2_000
      assert.deepEqual(await searchItunes('Song A', { fetchFn: answered, now }), [{ trackName: 'Song A' }])
      assert.equal(calls, 2)
    } finally {
      resetItunesBackoff()
    }
  }
})

test('a playlist folder with songs waiting for review is kept, so picks can be saved into it', async () => {
  const drive = makeDriveFolder()

  const job = await withServices(
    { searchVideos: async () => [searchResult('teraBan1234', 'Tera Ban Jaunga | Kabir Singh')] },
    async () => {
      const upload = await uploadCsv('Track Name,Artist\nTum Hi Ho,Arijit Singh\n', { saveTo: drive })
      return (await waitForJob(upload.body.jobId)).body
    }
  )
  await sleep(300) // cleanup runs in the background once the job ends

  assert.equal(job.reviewCount, 1)
  assert.ok(fs.existsSync(job.saveFolder), 'the empty playlist folder must stay for the picks')
})

// --- YouTube sign-in (cookies from a browser) and short failure reasons ---

const BOT_CHECK_ERROR =
  'ERROR: [youtube] LrM_Y39Gmhk: Sign in to confirm you\u2019re not a bot. This helps protect our ' +
  'community. Use --cookies-from-browser or --cookies for the authentication.'

test('an unknown browser for the YouTube sign-in is refused', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS, { cookiesBrowser: 'netscape' })
  const picks = await postJson('/picks', {
    name: 'Mix',
    cookiesBrowser: 'netscape',
    songs: [{ title: 'Song', artist: 'Someone', videoId: 'LrM_Y39Gmhk' }]
  })

  assert.equal(upload.status, 400)
  assert.match(upload.body.error, /browser/i)
  assert.equal(picks.status, 400)
  assert.match(picks.body.error, /browser/i)
})

test('the chosen browser sign-in is handed to every download', async () => {
  const seen = []

  await withServices(
    {
      searchVideos: async () => [searchResult('LrM_Y39Gmhk', 'Monkeys Spinning Monkeys - Kevin MacLeod')],
      downloadMP3: async (url, template, quality, options) => {
        seen.push(options.cookiesBrowser)
        throw new Error('not downloading in a test')
      }
    },
    async () => {
      const upload = await uploadCsv('Track Name,Artist\nMonkeys Spinning Monkeys,Kevin MacLeod\n', {
        cookiesBrowser: 'Chrome'
      })
      return waitForJob(upload.body.jobId)
    }
  )

  assert.deepEqual(seen, ['chrome'])
})

test('yt-dlp gets --cookies-from-browser only when a browser was chosen', () => {
  const withSignIn = ytDlpDownloadFlags('out/%(ext)s', '128', 'chrome')
  const without = ytDlpDownloadFlags('out/%(ext)s', '128', '')

  const at = withSignIn.indexOf('--cookies-from-browser')
  assert.ok(at >= 0)
  assert.equal(withSignIn[at + 1], 'chrome')
  assert.equal(without.includes('--cookies-from-browser'), false)
})

test("YouTube's bot check is summed up in one short line", () => {
  const reason = shortErrorReason({ stderr: BOT_CHECK_ERROR })

  assert.match(reason, /confirm you're not a bot/)
  assert.match(reason, /YouTube sign-in/)
  assert.ok(reason.length < 120)
})

test("other yt-dlp errors keep just their first sentence, without the video id", () => {
  const reason = shortErrorReason({
    stderr:
      'ERROR: [youtube] abcdefghijk: Video unavailable. This video is no longer available because ' +
      'the YouTube account associated with this video has been terminated.'
  })

  assert.equal(reason, 'Video unavailable.')
})

// --- fixes from the security review ---

test('Stop during "Download selected" keeps the unsaved picks on the review list', async () => {
  const songs = [
    { title: 'Song A', artist: 'Someone', videoId: 'aaaaaaaaaaa' },
    { title: 'Song B', artist: 'Someone', videoId: 'bbbbbbbbbbb' },
    { title: 'Song C', artist: 'Someone', videoId: 'ccccccccccc' }
  ]

  const job = await withServices({ downloadMP3: downloadUntilStopped }, async () => {
    const started = await postJson('/picks', { name: 'Road Trip', parallel: 1, songs })
    await control(started.body.jobId, 'stop')
    return (await waitForJob(started.body.jobId)).body
  })

  assert.equal(job.error, 'Stopped before any song was saved.')
  assert.deepEqual(job.reviews.map((r) => r.title), ['Song A', 'Song B', 'Song C'])
  assert.ok(job.reviews.every((r) => r.reason === 'Not downloaded: stopped'))
  assert.deepEqual(
    job.reviews.map((r) => r.candidates[0].videoId),
    ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'],
    'each keeps the version that was picked'
  )
})

test('"Search wider" never runs more than a few YouTube searches at once', async () => {
  let inFlight = 0
  let mostAtOnce = 0

  await withServices(
    {
      searchVideos: async () => {
        inFlight++
        mostAtOnce = Math.max(mostAtOnce, inFlight)
        await sleep(30)
        inFlight--
        return []
      }
    },
    () =>
      Promise.all([1, 2, 3].map(() => postJson('/alternatives', { title: 'Song A', artist: 'Someone' })))
  )

  assert.ok(mostAtOnce <= 4, `${mostAtOnce} searches ran at once`)
})

test('a CSV name made of dots can never become "." or ".."', () => {
  assert.equal(makeFileBaseFromTitle('. ..'), '')
  assert.equal(makeFileBaseFromTitle('.:..'), '')
  assert.equal(makeFileBaseFromTitle(' . . '), '')
})

test('a "$" in the save folder never reaches yt-dlp, which would expand it', async () => {
  const drive = path.join(makeDriveFolder(), 'Mixes $HOME')
  fs.mkdirSync(drive)
  let call = null

  await withServices(
    {
      downloadMP3: async (url, outputTemplate, quality, options) => {
        call = { outputTemplate, cwd: options.cwd }
        throw new Error('not downloading in a test')
      }
    },
    async () => {
      const res = await postJson('/picks', { name: 'Road Trip', saveFolder: drive, songs: [PICKED_SONG] })
      return waitForJob(res.body.jobId)
    }
  )

  assert.equal(call.outputTemplate, 'track_1.%(ext)s', 'no folder in the template')
  assert.ok(call.cwd.startsWith(drive), 'yt-dlp runs inside the work folder instead')
})

test('start-up cleanup only removes work folders the app itself made', () => {
  assert.equal(isLeftoverWorkFolder('mp3s_1795188260792'), true)
  assert.equal(isLeftoverWorkFolder('mp3s_3f2b9c1e-8d4a-4e2f-9b1a-0c5d6e7f8a9b'), true)
  assert.equal(isLeftoverWorkFolder('mp3s_backup'), false)
  assert.equal(isLeftoverWorkFolder('mp3s_rescued-songs'), false)
})

// --- fixes from the review of the review list ---

test('picks a failed run never got to stay on the review list with their picked version', async () => {
  const songs = [
    { title: 'Song A', artist: 'Someone', videoId: 'aaaaaaaaaaa' },
    { title: 'Song B', artist: 'Someone', videoId: 'bbbbbbbbbbb' }
  ]
  // the drive is full, or it was unplugged after the run was asked for
  const fullDrive = async () => ({ bavail: 0, bsize: 4096 })
  const unpluggedDrive = async () => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  }

  for (const statfs of [fullDrive, unpluggedDrive]) {
    const realStatfs = fs.promises.statfs
    fs.promises.statfs = statfs
    try {
      const res = await postJson('/picks', { name: 'Road Trip', songs })
      const job = (await waitForJob(res.body.jobId)).body

      assert.equal(job.status, 'error')
      assert.deepEqual(
        job.reviews.map((r) => [r.title, r.reason, r.candidates.map((c) => c.videoId)]),
        [
          ['Song A', 'Not downloaded: the run failed', ['aaaaaaaaaaa']],
          ['Song B', 'Not downloaded: the run failed', ['bbbbbbbbbbb']]
        ],
        `${statfs.name}: every pick comes back with the version that was picked`
      )
    } finally {
      fs.promises.statfs = realStatfs
    }
  }
})

// "Tum Hi Ho" (4:22) the way YouTube might answer it: a live take on the
// artist's Topic channel and an overlong video both outscore a plain upload
// of the right song at the right length
const LIVE_TAKE = searchResult('tumHiHoLive', 'Tum Hi Ho (Live) | Arijit Singh', {
  channel: 'Arijit Singh - Topic',
  durationSec: 268
})
const LONG_VIDEO = searchResult('tumHiHoLong', 'Tum Hi Ho | Aashiqui 2 | Arijit Singh', { durationSec: 420 })
const PLAIN_UPLOAD = searchResult('tumHiHoPlan', 'Tum Hi Ho', { channel: 'Romantic Hits', durationSec: 262 })
const TUM_HI_HO_CSV = 'Track Name,Artist,Duration\nTum Hi Ho,Arijit Singh,4:22\n'

test('a sure match further down the results is downloaded instead of listing the song', async () => {
  const downloaded = []
  const job = await runCsvWith(
    {
      searchVideos: async () => [LIVE_TAKE, LONG_VIDEO, PLAIN_UPLOAD],
      downloadMP3: async (url) => {
        downloaded.push(url)
        throw new Error('not downloading in a test')
      }
    },
    TUM_HI_HO_CSV
  )

  assert.deepEqual(downloaded, [PLAIN_UPLOAD.url])
  assert.deepEqual(
    job.events.filter((e) => e.text.startsWith('? ')),
    [],
    'not listed as a song without a match'
  )
})

test('a live take or an overlong video is never offered as a "Good match"', async () => {
  const job = await runCsvWith({ searchVideos: async () => [LIVE_TAKE, LONG_VIDEO] }, TUM_HI_HO_CSV)
  const wider = await withServices(
    { searchVideos: async () => [LIVE_TAKE, LONG_VIDEO, PLAIN_UPLOAD] },
    () => postJson('/alternatives', { title: 'Tum Hi Ho', artist: 'Arijit Singh', durationSec: 262 })
  )

  assert.equal(job.reviews[0].reason, 'No exact match on YouTube')
  assert.deepEqual(
    job.reviews[0].candidates.map((c) => [c.videoId, c.label]),
    [['tumHiHoLive', 'Possible'], ['tumHiHoLong', 'Possible']]
  )
  assert.deepEqual(
    wider.body.candidates.map((c) => [c.videoId, c.label]),
    [['tumHiHoLive', 'Possible'], ['tumHiHoLong', 'Possible'], ['tumHiHoPlan', 'Good match']]
  )
})

test('many downloads at once share Stop without a "possible memory leak" warning', async () => {
  const PARALLEL = 12
  const warnings = []
  const onWarning = (warning) => warnings.push(warning.name)
  const songs = Array.from({ length: PARALLEL }, (_, i) => ({
    title: `Song ${i}`,
    artist: 'Someone',
    videoId: `abcdefghi${String(i).padStart(2, '0')}`
  }))

  process.on('warning', onWarning)
  try {
    await withServices({ downloadMP3: downloadUntilStopped }, async () => {
      const started = await postJson('/picks', { name: 'Big Mix', parallel: PARALLEL, songs })
      const jobId = started.body.jobId
      const deadline = Date.now() + CLEANUP_TIMEOUT_MS // every download starts, then waits for Stop
      while (Date.now() < deadline && (await progressOf(jobId)).active.length < PARALLEL) await sleep(20)
      await control(jobId, 'stop')
      return waitForJob(jobId)
    })
    await sleep(50) // warnings are emitted on a later tick
  } finally {
    process.off('warning', onWarning)
  }

  assert.equal(warnings.includes('MaxListenersExceededWarning'), false)
})

test("yt-dlp gets this app's own Node to solve YouTube's JavaScript challenges", () => {
  // without a JS runtime, YouTube (especially when signed in) answers with
  // "Signature solving failed … Only images are available for download"
  const flags = ytDlpDownloadFlags('out/%(ext)s', '0', '')
  const at = flags.indexOf('--js-runtimes')

  assert.ok(at >= 0, 'no --js-runtimes flag')
  assert.equal(flags[at + 1], `node:${process.execPath}`)
})

// --- "Download at once" during a run, time left, charts and the recent list ---

const HISTORY_POINT_KEYS = ['active', 'done', 'parallel', 'savedBytes', 'speedBps', 't']
// a running job samples its history this often
const HISTORY_SAMPLE_MS = 2_000

// Poll /progress until isReady(job) holds or the time runs out, and return
// the job as it last was (so a failed assertion shows what it got to)
async function waitForProgress (jobId, isReady, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let job = await progressOf(jobId)
  while (!isReady(job) && Date.now() < deadline) {
    await sleep(20)
    job = await progressOf(jobId)
  }
  return job
}

function changeParallel (jobId, parallel) {
  return postJson(`/jobs/${encodeURIComponent(jobId)}/parallel`, { parallel })
}

// songs picked on the review list ("Song 1", "Song 2"…), each with its video
function pickedSongs (videoIds) {
  return videoIds.map((videoId, i) => ({ title: `Song ${i + 1}`, artist: 'Someone', videoId }))
}

// Start a "Download selected" run, hand its id to check(), then stop the run
// and wait for it to end, even when check() fails: a run left going would
// keep the test process alive
async function whileRunning (picksBody, check) {
  const started = await postJson('/picks', picksBody)
  const jobId = started.body.jobId
  try {
    return await check(jobId)
  } finally {
    await control(jobId, 'stop')
    await waitForJob(jobId)
  }
}

test('"Download at once" only changes to a whole number from 1 to 20, while the run goes on', async () => {
  const upload = await uploadCsv(CSV_WITHOUT_SONGS)
  const jobId = upload.body.jobId
  await waitForJob(jobId)

  for (const parallel of [0, 21, 'abc', 2.5]) {
    const res = await changeParallel(jobId, parallel)
    assert.equal(res.status, 400, `${JSON.stringify(parallel)} is refused`)
    assert.deepEqual(res.body, { error: 'Choose 1 to 20 downloads at once.' })
  }
  assert.equal((await changeParallel('no-such-job', 5)).status, 404)
  const finished = await changeParallel(jobId, '5')
  assert.equal(finished.status, 409, 'a number as text is fine, but this run is over')
  assert.match(finished.body.error, /finished/)
  const notJson = await postJson(`/jobs/${jobId}/parallel`, '{"parallel": ')
  assert.equal(notJson.status, 400)
  assert.match(notJson.body.error, /not valid JSON/)
})

test('raising "Download at once" mid-run starts more songs within a second, and the history shows it', async () => {
  const songs = pickedSongs(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'])

  const { before, raised, after, sampled } = await withServices(
    { downloadMP3: downloadUntilStopped },
    () =>
      whileRunning({ name: 'Mix', parallel: 1, songs }, async (jobId) => {
        const before = await waitForProgress(jobId, (job) => job.active.length >= 1)
        const raised = await changeParallel(jobId, 3)
        const after = await waitForProgress(jobId, (job) => job.active.length >= 3, 1_000)
        const sampled = await waitForProgress(
          jobId,
          (job) => job.history.some((point) => point.parallel === 3),
          HISTORY_SAMPLE_MS + 1_000
        )
        return { before, raised, after, sampled }
      })
  )

  assert.equal(before.activeCount, 1)
  assert.equal(raised.status, 200)
  assert.equal(raised.body.parallel, 3, 'answers with the job, the way /progress does')
  assert.equal(after.activeCount, 3)
  assert.equal(after.parallel, 3)
  assert.deepEqual(
    sampled.history.map((point) => Object.keys(point).sort()),
    sampled.history.map(() => HISTORY_POINT_KEYS)
  )
  assert.ok(
    sampled.history.some((point) => point.parallel === 3 && point.active === 3),
    'a point taken while the run went on, at the new limit'
  )
})

test('raising "Download at once" to 20 mid-run shares Stop without a "possible memory leak" warning', async () => {
  const MOST_AT_ONCE = 20
  const songs = pickedSongs(
    Array.from({ length: MOST_AT_ONCE }, (_, i) => `abcdefghi${String(i).padStart(2, '0')}`)
  )
  const warnings = []
  const onWarning = (warning) => warnings.push(warning.name)
  let mostActive = 0

  process.on('warning', onWarning)
  try {
    await withServices({ downloadMP3: downloadUntilStopped }, () =>
      whileRunning({ name: 'Big Mix', parallel: 1, songs }, async (jobId) => {
        await waitForProgress(jobId, (job) => job.active.length >= 1)
        await changeParallel(jobId, MOST_AT_ONCE)
        const full = await waitForProgress(
          jobId,
          (job) => job.active.length >= MOST_AT_ONCE,
          CLEANUP_TIMEOUT_MS
        )
        mostActive = full.active.length
      })
    )
    await sleep(50) // warnings are emitted on a later tick
  } finally {
    process.off('warning', onWarning)
  }

  assert.equal(mostActive, MOST_AT_ONCE)
  assert.equal(warnings.includes('MaxListenersExceededWarning'), false)
})

test('time left waits for the first songs at once, then follows a new "Download at once" at once', async () => {
  const FIRST_SONGS_MS = 400
  const SONG_COUNT = 10
  const songs = pickedSongs(
    Array.from({ length: SONG_COUNT }, (_, i) => `song${String(i + 1).padStart(7, '0')}`)
  )
  // songs 1-3 (the first three at once) fail after a moment; the rest run until Stop
  const downloadMP3 = async (url, outputTemplate, quality, options) => {
    if (Number(url.slice(-7)) > 3) return downloadUntilStopped(url, outputTemplate, quality, options)
    await sleep(FIRST_SONGS_MS)
    throw new Error('ERROR: Video unavailable')
  }

  const { first, before, lowered } = await withServices({ downloadMP3 }, () =>
    whileRunning({ name: 'Mix', parallel: 3, songs }, async (jobId) => {
      const first = await waitForProgress(jobId, (job) => job.active.length === 3 && job.done === 0)
      const before = await waitForProgress(jobId, (job) => job.done === 3 && job.active.length === 3)
      const lowered = (await changeParallel(jobId, 1)).body
      return { first, before, lowered }
    })
  )

  assert.equal(first.etaMs, null, 'the first three started together: no pace until they are through')
  const expectedMs = (FIRST_SONGS_MS * (SONG_COUNT - 3)) / 3
  assert.ok(
    before.etaMs >= expectedMs * 0.9 && before.etaMs <= expectedMs * 2,
    `${before.etaMs} ms left, about ${expectedMs} ms expected (a song's time x 7 left / 3 at once)`
  )
  assert.equal(lowered.parallel, 1)
  assert.ok(lowered.etaMs >= before.etaMs * 2.5, `${lowered.etaMs} ms at 1 at once, from ${before.etaMs} ms at 3`)
})

test('a finished run has a history ending where it ended, and its songs in the recent list', async () => {
  const job = await runCsvWith(
    { searchVideos: async () => [searchResult('teraBan1234', 'Tera Ban Jaunga | Kabir Singh')] },
    'Track Name,Artist\nTum Hi Ho,Arijit Singh\n'
  )

  assert.ok(Array.isArray(job.history) && job.history.length >= 1, 'at least the point where it ended')
  for (const point of job.history) assert.deepEqual(Object.keys(point).sort(), HISTORY_POINT_KEYS)
  const { t, ...end } = job.history.at(-1)
  assert.equal(typeof t, 'number')
  assert.deepEqual(end, { done: 1, savedBytes: 0, speedBps: 0, active: 0, parallel: 3 })
  assert.equal(job.activeCount, 0)

  const { tookMs, ...song } = job.recent[0]
  assert.equal(job.recent.length, 1)
  assert.deepEqual(song, {
    number: 1,
    title: 'Tum Hi Ho',
    artist: 'Arijit Singh',
    outcome: 'review',
    bytes: null,
    reason: 'No exact match on YouTube'
  })
  assert.ok(tookMs >= 0, 'timed from when the song was started on')
})

test('the recent list has saved songs with their size, newest first', async () => {
  const drive = makeDriveFolder()
  const songs = pickedSongs(['aaaaaaaaaaa', 'bbbbbbbbbbb'])

  const job = await withServices(
    {
      downloadMP3: async (url, outputTemplate, quality, options) => {
        if (url.endsWith('bbbbbbbbbbb')) throw new Error('ERROR: Video unavailable')
        const mp3 = path.join(options.cwd, outputTemplate.replace('%(ext)s', 'mp3'))
        await fs.promises.writeFile(mp3, silentMp3())
      },
      fetchAlbumArt: async () => null
    },
    async () => {
      const res = await postJson('/picks', { name: 'Road Trip', saveFolder: drive, parallel: 1, songs })
      return (await waitForJob(res.body.jobId)).body
    }
  )

  assert.deepEqual(
    job.recent.map((song) => [song.number, song.outcome, song.reason]),
    [
      [2, 'review', 'Download failed: Video unavailable'],
      [1, 'saved', null]
    ]
  )
  assert.equal(job.recent[1].bytes, fs.statSync(path.join(drive, 'Song 1.mp3')).size)
  assert.equal(job.recent[0].bytes, null, 'only a saved song has a size')
  assert.ok(job.recent.every((song) => song.tookMs >= 0))
})

test('songs skipped as already saved are in the recent list, having taken no time', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  fs.mkdirSync(playlist)
  fs.writeFileSync(path.join(playlist, 'Song A.mp3'), 'audio from an earlier run')

  const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\n', {
    saveTo: drive,
    skipExisting: '1'
  })
  const job = (await waitForJob(upload.body.jobId)).body

  assert.deepEqual(job.recent, [
    { number: 1, title: 'Song A', artist: 'Someone', outcome: 'skipped', bytes: null, tookMs: null, reason: null }
  ])
})

test('a song whose search breaks is in the recent list as failed, with why', async () => {
  const job = await runCsvWith(
    {
      searchVideos: async () => {
        throw new Error('ERROR: Unable to reach YouTube')
      }
    },
    'Track Name,Artist\nSong A,Someone\n'
  )

  const { tookMs, ...song } = job.recent[0]
  assert.deepEqual(song, {
    number: 1,
    title: 'Song A',
    artist: 'Someone',
    outcome: 'failed',
    bytes: null,
    reason: 'Unable to reach YouTube'
  })
  assert.ok(tookMs >= 0)
})

test('the recent list sends the last 12 songs, newest first', async () => {
  const rows = Array.from({ length: 14 }, (_, i) => `${i},${i}`).join('\n')
  const upload = await uploadCsv(`foo,bar\n${rows}\n`, { parallel: '1' })
  const job = (await waitForJob(upload.body.jobId)).body

  assert.deepEqual(
    job.recent.map((song) => song.number),
    [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]
  )
  assert.deepEqual(job.recent[0], {
    number: 14,
    title: '',
    artist: '',
    outcome: 'failed',
    bytes: null,
    tookMs: null, // never started on: there was nothing to search for
    reason: 'Row with no title/artist'
  })
})

// --- run options: Keep Mac awake, car-ready playlists, reusing songs, auto-retry ---

const DEFAULT_OPTIONS = {
  keepAwake: true,
  numberTracks: false,
  writePlaylist: true,
  reuseSongs: true,
  autoRetry: true
}
// long enough for a poll (every 20 ms) to catch a song waiting to be tried again
const RETRY_WAIT_MS = 500

// stands in for YouTube: "Song A Someone" finds Song A's own upload
async function searchSomeone (query) {
  const title = query.replace(/ Someone$/, '')
  const videoId = title.replace(/\W/g, '').padEnd(11, '0').slice(0, 11)
  return [searchResult(videoId, `${title} | Someone`)]
}

// stands in for yt-dlp: a second of silence where yt-dlp would leave the song
async function downloadSilence (url, outputTemplate, quality, options) {
  const mp3 = path.join(options.cwd, outputTemplate.replace('%(ext)s', 'mp3'))
  await fs.promises.writeFile(mp3, silentMp3())
}

// every song found and "downloaded" offline, with no cover to fetch
const OFFLINE_SONGS = {
  searchVideos: searchSomeone,
  downloadMP3: downloadSilence,
  fetchAlbumArt: async () => null
}

// how yt-dlp fails when YouTube throttles a download
function forbidden () {
  return Object.assign(new Error('yt-dlp failed'), {
    stderr: 'ERROR: [youtube] SongA000000: HTTP Error 403: Forbidden\n'
  })
}

// a keep-awake that only counts who holds it, and how often it's let go
function countingKeepAwake () {
  const calls = { acquired: [], released: 0 }
  return {
    calls,
    acquire (reason) {
      calls.acquired = [...calls.acquired, reason]
      return () => {
        calls.released++
      }
    },
    isActive: () => calls.acquired.length > calls.released
  }
}

// the track number ffmpeg wrote into a song's tags ("1/3"), '' when none
function trackTagOf (file) {
  const args = ['-v', 'quiet', '-show_entries', 'format_tags=track', '-of', 'default=nw=1:nk=1', file]
  return execFileSync('ffprobe', args, { encoding: 'utf8' }).trim()
}

// An ID3v2.3 tag with these latin1 text frames, the way ffmpeg tags songs
function id3v23Tag (frames) {
  const body = Buffer.concat(
    Object.entries(frames).map(([id, text]) => {
      const content = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]) // 0: latin1
      const header = Buffer.alloc(10)
      header.write(id, 0, 'latin1')
      header.writeUInt32BE(content.length, 4) // v2.3 frame sizes are plain numbers
      return Buffer.concat([header, content])
    })
  )
  // the tag's own size is "syncsafe": 7 bits a byte
  const size = [21, 14, 7, 0].map((shift) => (body.length >> shift) & 0x7f)
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, ...size]), body])
}

// the options a "Download selected" run ended up with, or the refusal
async function pickOptions (body) {
  const res = await postJson('/picks', { name: 'Mix', songs: [PICKED_SONG], ...body })
  if (res.status !== 200) return res
  return (await waitForJob(res.body.jobId)).body.options
}

test('the run options are on by default (all but numbering) and come as "1"/"0" form fields', async () => {
  const drive = makeDriveFolder()

  const defaults = await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: drive })
  const flipped = await uploadCsv(CSV_WITHOUT_SONGS, {
    saveTo: drive,
    keepAwake: '0',
    numberTracks: '1',
    writePlaylist: '0',
    reuseSongs: '0',
    autoRetry: '0'
  })
  const zip = await uploadCsv(CSV_WITHOUT_SONGS, { numberTracks: '1' })
  const notOnOff = await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: drive, autoRetry: 'maybe' })

  assert.deepEqual((await waitForJob(defaults.body.jobId)).body.options, DEFAULT_OPTIONS)
  assert.deepEqual((await waitForJob(flipped.body.jobId)).body.options, {
    keepAwake: false,
    numberTracks: true,
    writePlaylist: false,
    reuseSongs: false,
    autoRetry: false
  })
  assert.deepEqual(
    (await waitForJob(zip.body.jobId)).body.options,
    { ...DEFAULT_OPTIONS, writePlaylist: false, reuseSongs: false },
    'numbering, the playlist file and reusing songs need a folder, not a ZIP'
  )
  assert.equal(notOnOff.status, 400)
  assert.match(notOnOff.body.error, /autoRetry/)
})

test('POST /picks takes the options as true/false, and a picked song may bring its CSV number', async () => {
  const drive = makeDriveFolder()
  const unavailable = async () => {
    throw new Error('ERROR: Video unavailable')
  }

  const results = await withServices({ downloadMP3: unavailable }, async () => ({
    defaults: await pickOptions({ saveFolder: drive }),
    flipped: await pickOptions({
      saveFolder: drive,
      keepAwake: false,
      numberTracks: true,
      writePlaylist: true,
      reuseSongs: true,
      autoRetry: false
    }),
    notOnOff: await pickOptions({ keepAwake: 'yes please' }),
    noNumber: await pickOptions({ songs: [{ ...PICKED_SONG, number: 0, trackTotal: 12 }] }),
    pastTheEnd: await pickOptions({ songs: [{ ...PICKED_SONG, number: 13, trackTotal: 12 }] })
  }))

  assert.deepEqual(
    results.defaults,
    { ...DEFAULT_OPTIONS, writePlaylist: false, reuseSongs: false },
    'picks never rewrite the playlist file, and the person chose their videos'
  )
  assert.deepEqual(results.flipped, {
    keepAwake: false,
    numberTracks: true,
    writePlaylist: false,
    reuseSongs: false,
    autoRetry: false
  })
  assert.equal(results.notOnOff.status, 400)
  assert.match(results.notOnOff.body.error, /keepAwake/)
  assert.equal(results.noNumber.status, 400)
  assert.match(results.noNumber.body.error, /number/)
  assert.equal(results.pastTheEnd.status, 400)
  assert.match(results.pastTheEnd.body.error, /trackTotal/)
})

test('Keep Mac awake: each run holds it once, and lets go however the run ends', async () => {
  const drive = makeDriveFolder()
  const keepAwake = countingKeepAwake()
  const holds = () => [keepAwake.calls.acquired.length, keepAwake.calls.released]

  await withServices({ ...OFFLINE_SONGS, keepAwake }, async () => {
    const saved = await uploadCsv('Track Name,Artist\nSong A,Someone\n', { saveTo: drive })
    assert.equal((await waitForJob(saved.body.jobId)).body.status, 'saved')
    await waitUntil(() => keepAwake.calls.released === 1)
    assert.deepEqual(holds(), [1, 1], 'a saved run')
    assert.match(keepAwake.calls.acquired[0], /^job /)

    const failed = await uploadCsv(CSV_WITHOUT_SONGS)
    assert.equal((await waitForJob(failed.body.jobId)).body.status, 'error')
    await waitUntil(() => keepAwake.calls.released === 2)
    assert.deepEqual(holds(), [2, 2], 'a failed run')

    const off = await uploadCsv(CSV_WITHOUT_SONGS, { keepAwake: '0' })
    const offJob = (await waitForJob(off.body.jobId)).body
    assert.deepEqual(holds(), [2, 2], 'keepAwake "0" leaves it alone')
    assert.equal(offJob.keepingAwake, false)
  })

  const { running, stopped } = await withServices(
    { downloadMP3: downloadUntilStopped, keepAwake },
    async () => {
      const started = await postJson('/picks', { name: 'Road Trip', songs: [PICKED_SONG] })
      const jobId = started.body.jobId
      const running = await waitForProgress(
        jobId,
        (job) => job.status !== 'running' || job.active.length === 1
      )
      await control(jobId, 'stop')
      return { running, stopped: (await waitForJob(jobId)).body }
    }
  )
  await waitUntil(() => keepAwake.calls.released === 3)

  assert.equal(running.keepingAwake, true, 'held while the run goes on')
  assert.equal(stopped.error, 'Stopped before any song was saved.')
  assert.equal(stopped.keepingAwake, false)
  assert.deepEqual(holds(), [3, 3], 'a stopped run')
})

test('Car-ready: songs are numbered, and ones saved earlier without a number get theirs', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  fs.mkdirSync(playlist)
  fs.writeFileSync(path.join(playlist, 'Song B.mp3'), 'saved by an earlier run')
  fs.writeFileSync(path.join(playlist, 'Song C.mp3'), 'an older copy')
  fs.writeFileSync(path.join(playlist, '03 - Song C.mp3'), 'the numbered one')

  const job = await withServices(OFFLINE_SONGS, async () => {
    const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\nSong B,Someone\nSong C,Someone\n', {
      saveTo: drive,
      skipExisting: '1',
      numberTracks: '1'
    })
    return (await waitForJob(upload.body.jobId)).body
  })

  assert.equal(job.status, 'saved')
  assert.equal(job.savedCount, 1)
  assert.equal(job.skippedCount, 2, 'a song saved under either name is skipped')
  assert.deepEqual(fs.readdirSync(playlist).sort(), [
    '01 - Song A.mp3',
    '02 - Song B.mp3',
    '03 - Song C.mp3',
    'My Playlist.m3u',
    'Song C.mp3'
  ])
  assert.equal(fs.readFileSync(path.join(playlist, '02 - Song B.mp3'), 'utf8'), 'saved by an earlier run')
  assert.equal(
    fs.readFileSync(path.join(playlist, '03 - Song C.mp3'), 'utf8'),
    'the numbered one',
    'a numbered file in the way is never overwritten'
  )
  assert.equal(trackTagOf(path.join(playlist, '01 - Song A.mp3')), '1/3')
  assert.deepEqual(
    fs.readFileSync(path.join(playlist, 'My Playlist.m3u'), 'utf8').split('\n').filter((line) => line.endsWith('.mp3')),
    ['01 - Song A.mp3', '02 - Song B.mp3', '03 - Song C.mp3']
  )
})

test("Car-ready: the playlist file lists the CSV's songs in its order, with their lengths", async () => {
  const drive = makeDriveFolder()
  const noPlaylistDrive = makeDriveFolder()
  // Song A takes longer, so Song B is saved first
  const downloadMP3 = async (url, ...rest) => {
    if (url.endsWith('SongA000000')) await sleep(300)
    return downloadSilence(url, ...rest)
  }
  const csv = 'Track Name,Artist,Duration\nSong A,Someone,4:00\nSong B,Someone,\n'

  const { job, noPlaylist } = await withServices({ ...OFFLINE_SONGS, downloadMP3 }, async () => {
    const upload = await uploadCsv(csv, { saveTo: drive })
    const job = (await waitForJob(upload.body.jobId)).body
    const off = await uploadCsv(csv, { saveTo: noPlaylistDrive, writePlaylist: '0' })
    return { job, noPlaylist: (await waitForJob(off.body.jobId)).body }
  })

  const playlist = path.join(drive, 'My Playlist')
  assert.deepEqual(job.recent.map((song) => song.number), [1, 2], 'Song B was saved first')
  assert.equal(job.playlistFile, path.join(playlist, 'My Playlist.m3u'))
  assert.equal(
    fs.readFileSync(job.playlistFile, 'utf8'),
    '#EXTM3U\n#EXTINF:240,Someone - Song A\nSong A.mp3\n#EXTINF:-1,Someone - Song B\nSong B.mp3\n'
  )
  assert.equal(trackTagOf(path.join(playlist, 'Song A.mp3')), '1/2', 'tagged with its number, even unnumbered')
  assert.equal(noPlaylist.status, 'saved')
  assert.equal(noPlaylist.playlistFile, null)
  assert.deepEqual(fs.readdirSync(path.join(noPlaylistDrive, 'My Playlist')).sort(), ['Song A.mp3', 'Song B.mp3'])
})

test('picked songs that bring their CSV number are numbered and tagged like the CSV run', async () => {
  const drive = makeDriveFolder()
  const songs = [
    { ...PICKED_SONG, number: 7, trackTotal: 12 },
    { title: 'Song B', artist: 'Someone', videoId: 'bbbbbbbbbbb' } // no number: saved by its title
  ]

  const job = await withServices({ downloadMP3: downloadSilence, fetchAlbumArt: async () => null }, async () => {
    const res = await postJson('/picks', { name: 'Road Trip', saveFolder: drive, numberTracks: true, songs })
    return (await waitForJob(res.body.jobId)).body
  })

  assert.equal(job.status, 'saved')
  assert.deepEqual(fs.readdirSync(drive).sort(), ['07 - Song A.mp3', 'Song B.mp3'])
  assert.equal(trackTagOf(path.join(drive, '07 - Song A.mp3')), '7/12')
  assert.equal(trackTagOf(path.join(drive, 'Song B.mp3')), '', 'no number to tag')
  assert.equal(job.playlistFile, null, "picks leave the playlist file to the CSV's own run")
})

test('Reuse: a song already in another playlist folder is copied in, not downloaded', async () => {
  const drive = makeDriveFolder()
  const world = path.join(drive, 'World')
  fs.mkdirSync(world)
  const song = Buffer.concat([id3v23Tag({ TIT2: 'Song A', TPE1: 'Someone' }), silentMp3()])
  fs.writeFileSync(path.join(world, 'Song A.mp3'), song)
  let searches = 0
  let downloads = 0
  const stubs = {
    searchVideos: async () => {
      searches++
      return []
    },
    downloadMP3: async () => {
      downloads++
    }
  }

  const { job, notReused } = await withServices(stubs, async () => {
    const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\n', { saveTo: drive })
    const job = (await waitForJob(upload.body.jobId)).body
    const off = await uploadCsv('Track Name,Artist\nSong A,Someone\n', { saveTo: drive, reuseSongs: '0' })
    return { job, notReused: (await waitForJob(off.body.jobId)).body }
  })

  assert.equal(downloads, 0)
  assert.equal(searches, 1, 'only the run with reuseSongs "0" looked the song up')
  assert.equal(job.status, 'saved')
  assert.deepEqual([job.savedCount, job.reusedCount, job.savedBytes], [1, 1, song.length])
  assert.deepEqual(fs.readFileSync(path.join(drive, 'My Playlist', 'Song A.mp3')), song)
  assert.ok(fs.existsSync(path.join(world, 'Song A.mp3')), 'the original stays where it was')
  assert.deepEqual(job.events.map((e) => e.text), ['↺ Song A — copied from World'])
  const { tookMs, ...recent } = job.recent[0]
  assert.deepEqual(recent, {
    number: 1,
    title: 'Song A',
    artist: 'Someone',
    outcome: 'reused',
    bytes: song.length,
    reason: 'copied from World'
  })
  assert.ok(tookMs >= 0)
  assert.equal(job.playlistFile, path.join(drive, 'My Playlist', 'My Playlist.m3u'))
  assert.equal(notReused.reusedCount, 0)
  assert.equal(notReused.reviews[0].reason, 'Not found on YouTube')
})

test('Auto-retry: a download refused with HTTP 403 is tried again after a wait, and saved', async () => {
  const drive = makeDriveFolder()
  let tries = 0
  const downloadMP3 = async (...args) => {
    tries++
    if (tries === 1) throw forbidden()
    return downloadSilence(...args)
  }

  const { waiting, job } = await withServices(
    { ...OFFLINE_SONGS, downloadMP3, retryDelaysMs: [RETRY_WAIT_MS] },
    async () => {
      const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\n', { saveTo: drive })
      const waiting = await waitForProgress(
        upload.body.jobId,
        (job) => job.status !== 'running' || job.active[0]?.phase === 'retrying'
      )
      return { waiting, job: (await waitForJob(upload.body.jobId)).body }
    }
  )

  const [song] = waiting.active
  assert.equal(song?.phase, 'retrying')
  assert.equal(song.attempt, 2)
  assert.ok(song.retryInMs > 0 && song.retryInMs <= RETRY_WAIT_MS, `retrying in ${song.retryInMs} ms`)
  assert.equal(tries, 2)
  assert.equal(job.status, 'saved')
  assert.equal(job.savedCount, 1)
  assert.deepEqual(job.failures, [])
})

test('Auto-retry: an unavailable video is not tried again, and autoRetry "0" tries once', async () => {
  const runs = []
  const unavailable = () => new Error('ERROR: [youtube] SongA000000: Video unavailable')

  for (const [error, fields] of [[unavailable, {}], [forbidden, { autoRetry: '0' }], [forbidden, {}]]) {
    let tries = 0
    const downloadMP3 = async () => {
      tries++
      throw error()
    }
    const job = await withServices({ searchVideos: searchSomeone, downloadMP3 }, async () => {
      const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\n', fields)
      return (await waitForJob(upload.body.jobId)).body
    })
    runs.push([tries, job.reviews[0].reason])
  }

  assert.deepEqual(runs, [
    [1, 'Download failed: Video unavailable'],
    [1, 'Download failed: HTTP Error 403: Forbidden'],
    [3, 'Download failed: HTTP Error 403: Forbidden']
  ])
})

// --- songs that share a title, songs listed twice, the speed and the pace ---

// stands in for YouTube: every search finds an upload of just what was
// searched for ("<title> <artist>")
async function searchAnySong (query) {
  const videoId = query.replace(/\W/g, '').padEnd(11, '0').slice(0, 11)
  return [searchResult(videoId, query)]
}

const ANY_SONG_OFFLINE = { ...OFFLINE_SONGS, searchVideos: searchAnySong }

// stands in for yt-dlp, noting which videos were downloaded
function countingDownloads () {
  const urls = []
  const downloadMP3 = async (url, ...rest) => {
    urls.push(url)
    return downloadSilence(url, ...rest)
  }
  return { urls, downloadMP3 }
}

// the song files a playlist file lists, in its order
function playlistSongs (m3uPath) {
  return fs.readFileSync(m3uPath, 'utf8').split('\n').filter((line) => line.endsWith('.mp3'))
}

// a song saved (and tagged) by an earlier run, under `name`
function writeTaggedSong (folder, name, { title, artist }) {
  const song = Buffer.concat([id3v23Tag({ TIT2: title, TPE1: artist }), silentMp3()])
  fs.writeFileSync(path.join(folder, name), song)
}

// the artist ffmpeg wrote into a song's tags
function artistTagOf (file) {
  const args = ['-v', 'quiet', '-show_entries', 'format_tags=artist', '-of', 'default=nw=1:nk=1', file]
  return execFileSync('ffprobe', args, { encoding: 'utf8' }).trim()
}

test('two different songs with one title each get their own file, and a re-run skips both', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  // the drive ignores case, so "babydoll" is the same name as "Babydoll"
  const csv = 'Track Name,Artist Name(s)\nBabydoll,Dominic Fike\nSanta Baby,Eartha Kitt\nbabydoll,Jamie Miller\n'

  const { first, firstPlaylist, again } = await withServices(ANY_SONG_OFFLINE, async () => {
    const run = async (fields) => {
      const upload = await uploadCsv(csv, { saveTo: drive, skipExisting: '1', ...fields })
      return (await waitForJob(upload.body.jobId)).body
    }
    const first = await run({})
    const firstPlaylist = playlistSongs(first.playlistFile) // the re-run rewrites it
    return { first, firstPlaylist, again: await run({ numberTracks: '1' }) }
  })

  assert.equal(first.savedCount, 3)
  assert.deepEqual(firstPlaylist, [
    'Babydoll - Dominic Fike.mp3',
    'Santa Baby.mp3',
    'babydoll - Jamie Miller.mp3'
  ])
  assert.deepEqual([again.skippedCount, again.savedCount], [3, 0], 'each song found under its own name')
  assert.deepEqual(again.events.map((e) => e.text), [
    '↷ Babydoll - Dominic Fike — already in the folder',
    '↷ Santa Baby — already in the folder',
    '↷ babydoll - Jamie Miller — already in the folder'
  ])
  assert.deepEqual(fs.readdirSync(playlist).sort(), [
    '01 - Babydoll - Dominic Fike.mp3',
    '02 - Santa Baby.mp3',
    '03 - babydoll - Jamie Miller.mp3',
    'My Playlist.m3u'
  ], 'numbered by the car-ready re-run')
  assert.deepEqual(playlistSongs(again.playlistFile), [
    '01 - Babydoll - Dominic Fike.mp3',
    '02 - Santa Baby.mp3',
    '03 - babydoll - Jamie Miller.mp3'
  ])
  assert.equal(artistTagOf(path.join(playlist, '01 - Babydoll - Dominic Fike.mp3')), 'Dominic Fike')
  assert.equal(artistTagOf(path.join(playlist, '03 - babydoll - Jamie Miller.mp3')), 'Jamie Miller')
})

test('a song an earlier version saved under a shared title alone counts only for its own artist', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  fs.mkdirSync(playlist)
  writeTaggedSong(playlist, 'Babydoll.mp3', { title: 'Babydoll', artist: 'Dominic Fike' })
  writeTaggedSong(playlist, 'Santa Baby.mp3', { title: 'Santa Baby', artist: 'Eartha Kitt' })
  writeTaggedSong(playlist, 'Santa Baby (2).mp3', { title: 'Santa Baby', artist: 'Laufey' })
  const downloads = countingDownloads()
  const csv =
    'Track Name,Artist Name(s)\nBabydoll,Dominic Fike\nSanta Baby,Eartha Kitt\n' +
    'Babydoll,Jamie Miller\nSanta Baby,"Laufey,Someone Else"\n'

  const job = await withServices({ ...ANY_SONG_OFFLINE, downloadMP3: downloads.downloadMP3 }, async () => {
    const upload = await uploadCsv(csv, { saveTo: drive, skipExisting: '1' })
    return (await waitForJob(upload.body.jobId)).body
  })

  assert.deepEqual(downloads.urls, ['https://www.youtube.com/watch?v=BabydollJam'], "only Jamie Miller's Babydoll")
  assert.deepEqual([job.skippedCount, job.savedCount], [3, 1])
  assert.deepEqual(job.events.slice(0, 3).map((e) => e.text), [
    '↷ Babydoll - Dominic Fike — already in the folder',
    '↷ Santa Baby - Eartha Kitt — already in the folder',
    '↷ Santa Baby - Laufey — already in the folder'
  ])
  assert.deepEqual(playlistSongs(job.playlistFile), [
    'Babydoll.mp3',
    'Santa Baby.mp3',
    'Babydoll - Jamie Miller.mp3',
    'Santa Baby (2).mp3'
  ])
})

test('a song listed twice in the CSV is downloaded once, and its second row skipped', async () => {
  const drive = makeDriveFolder()
  const downloads = countingDownloads()

  const job = await withServices({ ...OFFLINE_SONGS, downloadMP3: downloads.downloadMP3 }, async () => {
    const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\nSong B,Someone\nSONG A,Someone\n', {
      saveTo: drive
    })
    return (await waitForJob(upload.body.jobId)).body
  })

  assert.equal(downloads.urls.length, 2)
  assert.deepEqual([job.savedCount, job.skippedCount, job.done], [2, 1, 3])
  assert.equal(job.events[0].text, '↷ SONG A — listed twice in the CSV')
  assert.deepEqual(job.recent.find((song) => song.number === 3), {
    number: 3,
    title: 'SONG A',
    artist: 'Someone',
    outcome: 'skipped',
    bytes: null,
    tookMs: null,
    reason: 'listed twice in the CSV'
  })
  assert.deepEqual(fs.readdirSync(path.join(drive, 'My Playlist')).sort(), [
    'My Playlist.m3u',
    'Song A.mp3',
    'Song B.mp3'
  ])
})

test('the speed on the chart is what was saved over the last 30 s, not 0 between downloads', async () => {
  const drive = makeDriveFolder()

  const job = await withServices(OFFLINE_SONGS, async () => {
    const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\n', { saveTo: drive })
    return (await waitForJob(upload.body.jobId)).body
  })

  const end = job.history.at(-1)
  assert.equal(end.savedBytes, job.savedBytes)
  assert.ok(end.savedBytes > 0 && end.t > 0 && end.t < 30_000, `${end.savedBytes} bytes at ${end.t} ms`)
  assert.equal(end.speedBps, Math.round(end.savedBytes / (end.t / 1_000)), 'what was saved, over the time so far')
})

test('a song copied in from another playlist sets no pace for the time left', async () => {
  const drive = makeDriveFolder()
  const world = path.join(drive, 'World')
  fs.mkdirSync(world)
  writeTaggedSong(world, 'Song A.mp3', { title: 'Song A', artist: 'Someone' })

  const running = await withServices({ searchVideos: searchSomeone, downloadMP3: downloadUntilStopped }, async () => {
    const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\nSong B,Someone\n', { saveTo: drive })
    const jobId = upload.body.jobId
    try {
      return await waitForProgress(
        jobId,
        (job) => job.status !== 'running' || (job.done === 1 && job.active.length === 1)
      )
    } finally {
      await control(jobId, 'stop')
      await waitForJob(jobId)
    }
  })

  assert.deepEqual([running.done, running.reusedCount], [1, 1])
  assert.equal(running.etaMs, null, 'a copy takes no download time, so it says nothing about the pace')
})

// --- finding a run again after a reload, and one run per folder ---

const JOB_SUMMARY_KEYS = ['done', 'endedAt', 'id', 'isPicks', 'name', 'saveFolder', 'startedAt', 'status', 'total']

async function listJobs () {
  const res = await fetch(`${baseUrl}/jobs`)
  return { status: res.status, body: await res.json() }
}

// GET a route with headers fetch won't let a test set (Origin, Host)
function getWithHeaders (route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${route}`, { headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('GET /jobs lists the runs still going and the finished ones kept, newest first', async () => {
  const finished = await uploadCsv(CSV_WITHOUT_SONGS)
  await waitForJob(finished.body.jobId)

  const listed = await withServices({ downloadMP3: downloadUntilStopped }, () =>
    whileRunning({ name: 'Mix', songs: [PICKED_SONG] }, async (jobId) => {
      await waitForProgress(jobId, (job) => job.active.length === 1)
      return { jobId, ...(await listJobs()) }
    })
  )

  assert.equal(listed.status, 200)
  const [running, ...older] = listed.body.jobs
  assert.deepEqual(listed.body.jobs.map((job) => Object.keys(job).sort()), listed.body.jobs.map(() => JOB_SUMMARY_KEYS))
  assert.deepEqual(
    { ...running, startedAt: typeof running.startedAt },
    {
      id: listed.jobId,
      name: 'Mix (picked)',
      status: 'running',
      total: 1,
      done: 0,
      saveFolder: null,
      startedAt: 'number',
      endedAt: null,
      isPicks: true
    },
    'the run going now comes first'
  )
  const failed = older.find((job) => job.id === finished.body.jobId)
  assert.deepEqual(
    [failed.name, failed.status, failed.isPicks, failed.total, failed.done],
    ['My Playlist', 'error', false, 1, 1]
  )
  assert.ok(failed.endedAt >= failed.startedAt, `ended at ${failed.endedAt}, started at ${failed.startedAt}`)
})

test('another website cannot list the runs', async () => {
  const port = server.address().port

  const crossSite = await getWithHeaders('/jobs', { origin: 'https://evil.example' })
  const rebound = await getWithHeaders('/jobs', { host: `evil.example:${port}` })

  assert.equal(crossSite.status, 403)
  assert.equal(rebound.status, 403)
})

test('finished runs stay listed for a reloaded page to find, at most the 20 newest', async () => {
  const ids = []
  for (let i = 0; i < 21; i++) {
    const upload = await uploadCsv(CSV_WITHOUT_SONGS)
    await waitForProgress(upload.body.jobId, (job) => job.status !== 'running')
    ids.push(upload.body.jobId)
  }

  const { jobs: listed } = (await listJobs()).body
  const records = listed.filter((job) => job.status === 'error' || job.status === 'saved')

  assert.deepEqual(records.map((job) => job.id), ids.slice(1).reverse(), 'newest first; the oldest one went')
  assert.equal((await fetch(`${baseUrl}/progress?job=${ids[0]}`)).status, 404)
  assert.equal((await fetch(`${baseUrl}/progress?job=${ids[1]}`)).status, 200)
})

test('a folder another run is still saving into is refused, so no song is saved twice', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  const csv = 'Track Name,Artist\nSong A,Someone\n'

  const { again, picks } = await withServices(
    { searchVideos: searchSomeone, downloadMP3: downloadUntilStopped },
    async () => {
      const first = await uploadCsv(csv, { saveTo: drive, skipExisting: '1' })
      try {
        await waitForProgress(first.body.jobId, (job) => job.active.length === 1)
        const again = await uploadCsv(csv, { saveTo: drive, skipExisting: '1' })
        const picks = await postJson('/picks', { name: 'My Playlist', saveFolder: playlist, songs: [PICKED_SONG] })
        return { again, picks }
      } finally {
        await control(first.body.jobId, 'stop')
        await waitForJob(first.body.jobId)
      }
    }
  )

  assert.equal(again.status, 409)
  assert.match(again.body.error, /already saving/)
  assert.equal(picks.status, 409)
  await waitUntil(() => fs.readdirSync(drive).length === 0) // the stopped run tidies up
  const later = await uploadCsv(CSV_WITHOUT_SONGS, { saveTo: drive, skipExisting: '1' })
  assert.equal(later.status, 200, 'free again once that run is over')
  await waitForJob(later.body.jobId)
})

test('a run that just failed is waited for, not refused, while it tidies up its folder', async () => {
  const drive = makeDriveFolder()
  const unavailable = async () => {
    throw new Error('ERROR: Video unavailable')
  }
  // hold the failed run's tidy-up (removing its hidden work folder) until told
  let finishTidyUp
  const tidyUpHeld = new Promise((resolve) => {
    finishTidyUp = resolve
  })
  const realRm = fs.promises.rm
  fs.promises.rm = async (target, options) => {
    if (path.basename(String(target)).startsWith('.zipify-work-')) await tidyUpHeld
    return realRm.call(fs.promises, target, options)
  }

  try {
    const { early, second } = await withServices({ downloadMP3: unavailable }, async () => {
      const first = await postJson('/picks', { name: 'Mix', saveFolder: drive, songs: [PICKED_SONG] })
      assert.equal((await waitForJob(first.body.jobId)).body.status, 'error') // over for the page
      const asked = postJson('/picks', { name: 'Mix', saveFolder: drive, songs: [PICKED_SONG] })
      const early = await Promise.race([asked.then(() => 'answered'), sleep(300).then(() => 'waiting')])
      finishTidyUp()
      const second = await asked
      if (second.status === 200) await waitForJob(second.body.jobId)
      return { early, second }
    })

    assert.equal(early, 'waiting', 'the new run waits for the tidy-up instead of being refused')
    assert.equal(second.status, 200, second.body.error)
  } finally {
    finishTidyUp()
    fs.promises.rm = realRm
  }
})

test('work files an interrupted run left in the playlist folder are cleared by the next run', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  const leftover = path.join(playlist, '.zipify-work-0badc0de')
  fs.mkdirSync(leftover, { recursive: true })
  fs.writeFileSync(path.join(leftover, 'track_3.mp3'), 'half a song')
  fs.writeFileSync(path.join(playlist, 'Song A.mp3'), 'audio from an earlier run')

  const upload = await uploadCsv('Track Name,Artist\nSong A,Someone\n', { saveTo: drive, skipExisting: '1' })
  const job = (await waitForJob(upload.body.jobId)).body

  assert.equal(job.status, 'saved')
  await waitUntil(() => fs.readdirSync(playlist).length === 2)
  assert.deepEqual(fs.readdirSync(playlist).sort(), ['My Playlist.m3u', 'Song A.mp3'])
})

// --- pen-drive names, blank rows, ✗ lines, what goes in a ZIP ---

test('songs saved under accented or differently cased names are found again, as a FAT32 drive lists them', async () => {
  const drive = makeDriveFolder()
  const playlist = path.join(drive, 'My Playlist')
  fs.mkdirSync(playlist)
  // macOS lists accented names on a FAT32 or exFAT drive decomposed (NFD),
  // and the drive ignores case
  writeTaggedSong(playlist, 'Tití Me Preguntó.mp3'.normalize('NFD'), { title: 'Titi Me Pregunto', artist: 'Bad Bunny' })
  writeTaggedSong(playlist, 'STAY.mp3', { title: 'STAY', artist: 'The Kid LAROI' })
  const downloads = countingDownloads()
  const csv = 'Track Name,Artist Name(s)\nTití Me Preguntó,Bad Bunny\nStay,The Kid LAROI\n'

  const job = await withServices({ ...ANY_SONG_OFFLINE, downloadMP3: downloads.downloadMP3 }, async () => {
    const upload = await uploadCsv(csv, { saveTo: drive, skipExisting: '1' })
    return (await waitForJob(upload.body.jobId)).body
  })

  assert.deepEqual(downloads.urls, [])
  assert.deepEqual([job.skippedCount, job.savedCount], [2, 0])
  assert.deepEqual(
    playlistSongs(job.playlistFile),
    ['Tití Me Preguntó.mp3'.normalize('NFC'), 'STAY.mp3'],
    'the playlist file names them the way the drive stores them: composed'
  )
})

test('two songs whose names differ only in case, finishing together, both keep their file', async () => {
  const folder = makeDriveFolder()
  fs.writeFileSync(path.join(folder, 'track_1.mp3'), 'The Kid LAROI')
  fs.writeFileSync(path.join(folder, 'track_2.mp3'), 'Rihanna')
  const reserved = new Set()

  const names = await Promise.all([
    renameToUniqueTitle(path.join(folder, 'track_1.mp3'), folder, 'STAY', reserved),
    renameToUniqueTitle(path.join(folder, 'track_2.mp3'), folder, 'Stay', reserved)
  ])

  assert.deepEqual(names.map((name) => path.basename(name)), ['STAY.mp3', 'Stay (2).mp3'])
  assert.deepEqual(fs.readdirSync(folder).sort(), ['STAY.mp3', 'Stay (2).mp3'])
})

test('a song name is cut to fit any drive, between whole characters', () => {
  assert.equal(makeFileBaseFromTitle('é'.repeat(150)), 'é'.repeat(100), '200 bytes')
  assert.equal(makeFileBaseFromTitle(`a${'😀'.repeat(60)}`), `a${'😀'.repeat(49)}`, 'never half an emoji')
  assert.equal(makeFileBaseFromTitle('Lorem ipsum '.repeat(20)), `${'Lorem ipsum '.repeat(16)}Lorem ip`)
  assert.equal(makeFileBaseFromTitle('Short Song'), 'Short Song')
})

test('a ZIP holds only the songs saved under their names, never a work file, and a very long title still saves', async () => {
  const longTitle = 'Lorem ipsum dolor '.repeat(17).trim() // 305 bytes: too long for any drive
  const csv = `Track Name,Artist\nShort Song,Someone\n${longTitle},Someone\nBroken Song,Someone\n`
  // the broken song's download leaves its work file (track_3.mp3) behind
  const downloadMP3 = async (url, outputTemplate, quality, options) => {
    await downloadSilence(url, outputTemplate, quality, options)
    if (url.includes('BrokenSong')) throw new Error('ERROR: the connection dropped')
  }

  const job = await withServices({ ...ANY_SONG_OFFLINE, downloadMP3 }, async () => {
    const upload = await uploadCsv(csv, { autoRetry: '0' })
    return (await waitForJob(upload.body.jobId)).body
  })
  const zip = Buffer.from(await (await fetch(`${baseUrl}/download/${job.id}`)).arrayBuffer())

  assert.equal(job.status, 'ready')
  assert.deepEqual([job.savedCount, job.downloaded, job.reviewCount], [2, 2, 1])
  assert.ok(zip.includes('Short Song.mp3'))
  assert.ok(zip.includes(`${'Lorem ipsum dolor '.repeat(11)}Lo.mp3`), 'the long title, cut to 200 bytes')
  assert.equal(zip.includes('track_'), false, 'no work file in the ZIP')
})

test('blank CSV rows (empty lines, rows of only commas) are left out, not counted as songs or failures', async () => {
  const csv = '\uFEFFTitle,Artist\r\nSong A,Someone\r\n\r\n,\r\nSong B,Other\r\n,,\r\n'

  const job = await runCsvWith(ANY_SONG_OFFLINE, csv)
  const onlyBlank = await uploadCsv('Track Name,Artist\n\n,\n,,\n')

  assert.deepEqual([job.total, job.done, job.savedCount], [2, 2, 2])
  assert.deepEqual(job.failures, [])
  assert.equal(onlyBlank.status, 400)
  assert.equal(onlyBlank.body.error, 'The CSV had no rows.')
})

test("a ✗ line names the song by its title and artist, not the CSV's first two columns", async () => {
  const job = await runCsvWith(
    { ...ANY_SONG_OFFLINE, downloadMP3: async () => { throw forbidden() } },
    'Rank,Song,Artist\n379,Babydoll,Jamie Miller\n'
  )

  assert.deepEqual(job.failures, ['Babydoll — Jamie Miller — HTTP Error 403: Forbidden'])
  assert.deepEqual(job.events.map((e) => e.text), ['✗ Babydoll — Jamie Miller — HTTP Error 403: Forbidden'])
})
