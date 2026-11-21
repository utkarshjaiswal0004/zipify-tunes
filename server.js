const express = require('express')
const multer = require('multer')
const fs = require('fs')
const csv = require('csv-parser')
const yts = require('yt-search')
const archiver = require('archiver')
const youtubedl = require('youtube-dl-exec')
const path = require('path')
const { randomUUID } = require('crypto')
const { setMaxListeners } = require('events')
const { spawn } = require('child_process')
const {
  listDrives,
  checkSaveFolder,
  makeUniqueFolder,
  openFolder,
  removeMacMetadataFor,
  removeMacTwinsOf,
  pickFolder
} = require('./save-folder')
const { runWithLimit } = require('./job-queue')
const { createKeepAwake } = require('./keep-awake')
const { numberedFileName, songFileNames, stripTrackPrefix, writeM3u } = require('./playlist-files')
const { buildLibraryIndex, findInLibrary, copyIntoPlaylist, readId3Tags } = require('./song-library')
const { DEFAULT_ATTEMPTS, DEFAULT_DELAYS_MS, withRetries } = require('./retry')
const {
  looseText,
  splitArtists,
  normalizeVideo,
  rankCandidates,
  isConfidentMatch,
  buildSearchQueries,
  parseDurationSec
} = require('./matching')
const {
  PROGRESS_TEMPLATE,
  progressUpdateFromLine,
  formatBytes,
  activeElapsedMs,
  currentPauseMs,
  estimateRemainingMsRecent,
  estimateTotalBytes,
  addHistoryPoint,
  thinEvenly,
  throughputBps
} = require('./progress')

const app = express()
const upload = multer({ dest: 'uploads/' })

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

// The names this server answers to: loopback, plus ZIPIFY_HOST when you've
// opened it to your network on purpose (e.g. ZIPIFY_HOST=192.168.1.20).
// Deliberately not HOST: many shells and tools set that to the machine name.
function allowedHostnames () {
  const extra = process.env.ZIPIFY_HOST
  return extra ? new Set([...LOOPBACK_HOSTNAMES, extra]) : LOOPBACK_HOSTNAMES
}

// Only the ZipifyTunes page may drive this server. It can save files into any
// folder you can write to, so refuse:
// - other websites posting a form here (browsers label those with an Origin
//   that isn't this server), and
// - a website pointing its own domain at 127.0.0.1 ("DNS rebinding"), which
//   looks same-origin to itself, so also insist on being addressed by a
//   name from allowedHostnames().
function onlyThisComputer (req, res, next) {
  const host = req.get('host') || ''
  const origin = req.get('origin')
  const isCrossSite = Boolean(origin) && origin !== `http://${host}`
  const isKnownName = allowedHostnames().has(host.replace(/:\d+$/, ''))

  if (isCrossSite || !isKnownName) {
    console.log(`Refused a request from ${origin || 'unknown origin'} to ${host}`)
    return res.status(403).send('Only the ZipifyTunes page on this computer can use this server.')
  }
  next()
}

app.use(onlyThisComputer)

// The song organizer (organize.html): scan a folder, then sort, rename, make
// playlists or clean duplicates, each previewed first and undoable. Mounted
// after onlyThisComputer so other websites can't drive it either.
app.use(require('./organizer/routes').createOrganizerRouter({ checkSaveFolder }))

// serve index.html + assets
app.use(express.static('.'))

// In-memory jobs (single-user / local use). The upload request returns a job
// id straight away; the page polls it and, once the tracks are ready, the
// browser fetches /download/<id> as a normal file download.
const jobs = new Map()

// a finished job that is never downloaded shouldn't hold its MP3s forever
const JOB_TTL_MS = 30 * 60 * 1000

// A job with nothing left to download (it failed, or saved to a folder) keeps
// just its record: the page's next poll reads the outcome from it, and a page
// reloaded soon after the run still finds it (GET /jobs) with its review list.
const RECORD_TTL_MS = 30 * 60 * 1000
// ...the newest this many of them, at most (a ZIP waiting to be fetched
// isn't one: its songs would go with it)
const MAX_RECORDS_KEPT = 20

// in folder mode the audio is downloaded into a hidden folder (this name plus
// part of the job id) inside the playlist folder, then moved into place once
// tagged
const WORK_FOLDER_PREFIX = '.zipify-work-'

// The folders running jobs save into (by folderKey). Two runs in one folder
// would save each song twice ("Song.mp3" and "Song (2).mp3"), or one would
// overwrite the other's file, so a second one is refused until the first is
// over, e.g. the same playlist started again from a reloaded page.
const foldersInUse = new Set()
// A failed run is over for the page at once but keeps its folder until it has
// tidied up (failJob). A new run there waits for that rather than being
// refused: the tidy-up's promise, by folderKey.
const foldersTidying = new Map()
const FOLDER_IN_USE_ERROR =
  'Another run is already saving songs into this folder. Let it finish (or stop it) first.'

// Songs downloaded at the same time. A few speed things up a lot; up to 20
// suits a fast connection, though YouTube tends to throttle (or briefly
// block) that many downloads at once, so it's the person's call.
const DEFAULT_PARALLEL = 3
const MAX_PARALLEL = 20
// the answer to "Download at once" being changed to anything else mid-run
const PARALLEL_RANGE_ERROR = `Choose 1 to ${MAX_PARALLEL} downloads at once.`

// what the page's Pause / Resume / Stop buttons ask for
const CONTROL_ACTIONS = { pause: 'pause', resume: 'run', stop: 'stop' }
// the answer to those, or to a new "Download at once", once a run is over
const RUN_FINISHED_ERROR = 'This run has already finished.'

// A ZIP job's work folder: "mp3s_" plus a job id, either the old timestamp
// kind or the current UUID. Nothing else, so a folder someone renamed to keep
// its songs ("mp3s_backup") is never touched.
const WORK_FOLDER_NAME =
  /^mp3s_(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

function isLeftoverWorkFolder (name) {
  return WORK_FOLDER_NAME.test(name)
}

// leftovers from a crashed or killed run
for (const entry of fs.readdirSync('.')) {
  if (isLeftoverWorkFolder(entry)) {
    fs.rmSync(entry, { recursive: true, force: true })
  }
}

// YouTube keeps changing how it serves audio, so a yt-dlp binary that is a few
// months old starts failing every download with "HTTP Error 403: Forbidden".
// Self-update the bundled binary on boot; downloads wait for this to settle so
// we never swap the binary out from under a running download.
const ytDlpPath = youtubedl.constants.YOUTUBE_DL_PATH

function updateYtDlp () {
  return new Promise((resolve) => {
    const proc = spawn(ytDlpPath, ['-U'])
    let out = ''

    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (out += d.toString()))

    // don't let a hanging network call block the server forever
    const timer = setTimeout(() => proc.kill(), 60_000)

    proc.on('close', () => {
      clearTimeout(timer)
      const summary = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^(Latest version|Updated yt-dlp|yt-dlp is up to date)/.test(l))
      console.log(summary.length ? summary.join('\n') : 'yt-dlp update check done')
      resolve()
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      console.log('Could not update yt-dlp, using the bundled version:', err.message)
      resolve()
    })
  })
}

const ytDlpReady = updateYtDlp()

// normalize user-entered quality (e.g. "128" -> "128K", "best" -> "0")
function normalizeQuality (q) {
  if (!q) return '0' // default: best VBR
  q = String(q).trim().toLowerCase()

  if (q === 'best' || q === '0') return '0' // yt-dlp: 0 = best VBR
  if (/^\d+$/.test(q)) return q + 'K' // "128" -> "128K"
  if (/^\d+k$/.test(q)) return q.toUpperCase() // "128k" -> "128K"

  return '0'
}

// The longest file name base, in bytes of UTF-8. FAT32 and exFAT allow 255
// characters, APFS and ext4 255 bytes, and a song's name may still get
// "007 - " before it, " (2)" and ".mp3" after it, and a "._" twin from macOS.
const MAX_FILE_BASE_BYTES = 200

// Cut text to at most maxBytes of UTF-8, between whole characters, so an
// emoji or a Hindi letter is never left as half a character
function cutToBytes (text, maxBytes) {
  let bytes = 0
  let end = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > maxBytes) break
    end += char.length
  }
  return text.slice(0, end)
}

// A file name base no drive refuses as too long
function shortFileBase (text) {
  return cutToBytes(text, MAX_FILE_BASE_BYTES).trim()
}

// turn song title into a safe filename WITH SPACES (no slashes etc)
function makeFileBaseFromTitle (title) {
  const cleaned = String(title)
    .replace(/[\/\\?%*:|"<>]/g, ' ') // remove path-unsafe chars
    .replace(/\s+/g, ' ') // collapse multiple spaces
    .trim()
    // a leading dot would hide the file ("._" reads as macOS metadata), and a
    // name of only dots and spaces must never become "." or ".."
    .replace(/^[.\s]+/, '')
  return shortFileBase(cleaned)
}

// The path for "<fileBase>.mp3" in folder, adding " (2)", " (3)"… on
// collisions. `reserved` holds names that songs running in parallel have
// claimed but may not have moved into place yet (by nameKey: a pen drive
// takes "STAY.mp3" and "Stay.mp3" for one file); the name returned is added
// to it before any await, so no other song can take it.
function claimUniqueName (folder, fileBase, reserved) {
  let candidate = path.join(folder, `${fileBase}.mp3`)
  let n = 2

  while (fs.existsSync(candidate) || reserved.has(nameKey(candidate))) {
    candidate = path.join(folder, `${fileBase} (${n}).mp3`)
    n++
  }

  reserved.add(nameKey(candidate))
  return candidate
}

// a name claimed with claimUniqueName that the song didn't use after all
function releaseName (reserved, filePath) {
  reserved.delete(nameKey(filePath))
}

// Move the finished MP3 to "<title>.mp3" (or "<title> (2).mp3"…)
async function renameToUniqueTitle (mp3Path, folder, fileBase, reserved = new Set()) {
  const candidate = claimUniqueName(folder, fileBase, reserved)
  await fs.promises.rename(mp3Path, candidate)
  return candidate
}

// longest failure reason shown on the page
const MAX_REASON_CHARS = 140
// YouTube's anti-bot wall, worded for people rather than yt-dlp users
const BOT_CHECK = /confirm you.{0,3}re not a bot/i
const BOT_CHECK_REASON =
  "YouTube wants to confirm you're not a bot (turn on YouTube sign-in, or try again later)"

// The part of an error worth showing: yt-dlp's "ERROR: …" line if it has one,
// without its "[youtube] <video id>: " prefix, cut to the first sentence.
function shortErrorReason (err) {
  const raw = String(err.stderr || err.message || err)
  if (BOT_CHECK.test(raw)) return BOT_CHECK_REASON

  const line =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('ERROR:')) || raw.split('\n')[0]
  const reason = line.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
  const firstSentence = reason.split(/(?<=\.)\s/)[0]

  return firstSentence.length > MAX_REASON_CHARS
    ? firstSentence.slice(0, MAX_REASON_CHARS - 1) + '…'
    : firstSentence
}

// Short, human-readable reason for the failure list we send back to the
// browser: "Babydoll — Jamie Miller — HTTP Error 403: Forbidden". The song is
// named by its title and artist (two songs may share a title); the CSV's
// first columns (a rank, a Spotify id) only stand in when it has neither.
function describeSongFailure (song, err) {
  const label =
    [song.title, song.artist].filter(Boolean).join(' — ') ||
    Object.values(song.row ?? {}).slice(0, 2).join(' ').trim() ||
    'Unknown track'
  return `${label} — ${shortErrorReason(err)}`
}

async function freeSpace (dir) {
  const { bavail, bsize } = await fs.promises.statfs(dir)
  return bavail * bsize
}

// rough guess used before anything is downloaded: MP3s land around 5-10 MB
const ESTIMATED_BYTES_PER_TRACK = 10 * 1024 * 1024

// A run needs two copies of the audio on the same disk: the temp MP3s and the
// ZIP the browser saves. (The browser streams the ZIP straight to disk, so it
// doesn't need a third, buffered copy.)
const PEAK_COPIES = 2

// Space to ask for before a run starts. Saving straight to a folder keeps a
// single copy: the MP3s are the result, there's no ZIP.
function estimateBytesNeeded (trackCount, { toFolder }) {
  const copies = toFolder ? 1 : PEAK_COPIES
  return trackCount * ESTIMATED_BYTES_PER_TRACK * copies
}

// strip case and separators so "Album Date", "album_date" and "albumdate"
// all collapse to the same key (also drops any BOM left on the first header)
function normalizeKey (key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
}

// helper: get first non-empty field from a list of possible column names
function getField (row, candidates) {
  const byKey = new Map()
  for (const key of Object.keys(row)) {
    const normalized = normalizeKey(key)
    if (!byKey.has(normalized)) byKey.set(normalized, row[key])
  }

  for (const candidate of candidates) {
    const raw = byKey.get(normalizeKey(candidate))
    if (raw != null) {
      const val = String(raw).trim()
      if (val) return val
    }
  }
  return ''
}

// helper: derive year from multiple possible fields
function getYear (row) {
  // direct year-ish fields
  const directYearRaw = getField(row, [
    'year',
    'Year',
    'release_year',
    'Release Year',
    'ReleaseYear',
    'published_year',
    'Published Year'
  ])

  if (directYearRaw) {
    const m = String(directYearRaw).match(/\d{4}/)
    if (m) return m[0]
  }

  // album / release date style fields
  const albumDateRaw = getField(row, [
    'albumdate',
    'AlbumDate',
    'album_date',
    'album date',
    'album_release_date',
    'Album Release Date',
    'release_date',
    'Release Date',
    'released_at',
    'Released At',
    'date',
    'Date'
  ])

  if (albumDateRaw) {
    const m = String(albumDateRaw).match(/\d{4}/)
    if (m) return m[0]
  }

  return ''
}

// helper: get genre from multiple possible fields
function getGenre (row) {
  return getField(row, [
    'genre',
    'Genre',
    'genres',
    'Genres',
    'style',
    'Style',
    'mood',
    'Mood'
  ])
}

// Run the bundled yt-dlp and resolve with its stdout. youtube-dl-exec's own
// runner splits the binary path at spaces, so it can't start yt-dlp when the
// app lives in a folder like "Application Support"; spawn it directly instead.
// On failure the error carries yt-dlp's stderr (describeSongFailure reads it).
// onLine, if given, sees each stdout line as it arrives (progress updates);
// aborting `signal` kills yt-dlp (the page's Stop button); `cwd` is the
// folder it runs in; `binary` is the yt-dlp to run (the bundled one).
function runYtDlp (args, { onLine, signal, cwd, binary = ytDlpPath } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { signal, cwd })
    let stdout = '' // only kept when nobody is reading it line by line
    let stderr = ''
    let partialLine = ''

    // decode as UTF-8 here so a character split across two chunks survives
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    proc.stdout.on('data', (d) => {
      if (!onLine) {
        stdout += d
        return
      }
      const lines = (partialLine + d).split('\n')
      partialLine = lines.pop()
      lines.forEach(onLine)
    })
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (onLine && partialLine) onLine(partialLine)
      if (code === 0) return resolve(stdout.trim())
      const message = stderr.trim() || `yt-dlp exited with code ${code}`
      reject(Object.assign(new Error(message), { stderr, exitCode: code }))
    })
  })
}

// 1) Download MP3 audio only (no metadata, no thumbnail). onProgress gets
// { phase: 'downloading', downloadedBytes, totalBytes, speedBps } while the
// audio comes in, then { phase: 'converting' } once yt-dlp turns it into MP3.
// yt-dlp's arguments for one download (turned into argv by youtube-dl-exec's
// helper); cookiesBrowser, when set, lends it that browser's YouTube sign-in
function ytDlpDownloadFlags (outputTemplate, userQuality, cookiesBrowser) {
  return youtubedl.args({
    extractAudio: true, // -x / --extract-audio
    audioFormat: 'mp3', // --audio-format mp3
    audioQuality: normalizeQuality(userQuality), // --audio-quality (0-10 or "128K" etc)
    noPlaylist: true, // --no-playlist
    output: outputTemplate, // -o "<folder>/<file>.%(ext)s"
    // one machine-readable progress line per update, even though stdout is a pipe
    newline: true,
    progress: true,
    progressTemplate: PROGRESS_TEMPLATE,
    // YouTube makes clients solve JavaScript challenges before it hands out
    // audio (always when signed in). yt-dlp ships the solver but only looks
    // for Deno to run it, so lend it the Node this server already runs on.
    jsRuntimes: `node:${process.execPath}`,
    ...(cookiesBrowser ? { cookiesFromBrowser: cookiesBrowser } : {})
    // NOTE: no embedThumbnail / addMetadata here
  })
}

function downloadMP3 (
  url,
  outputTemplate,
  userQuality,
  { onProgress = () => {}, signal, cookiesBrowser = '', cwd } = {}
) {
  const flags = ytDlpDownloadFlags(outputTemplate, userQuality, cookiesBrowser)

  return runYtDlp([url, ...flags], {
    signal,
    cwd,
    onLine: (line) => {
      const update = progressUpdateFromLine(line)
      if (update) onProgress(update)
    }
  })
}

// yt-search now and then comes back empty for songs that are on YouTube (about
// 1 in 12 of a real 500-song run), so ask it twice, then fall back to
// yt-dlp's own search. Resolves with the results in normalizeVideo's shape,
// YouTube's best guess first, or [] when nothing turns up. It never throws:
// one failed search mustn't end a run.
const YT_SEARCH_ATTEMPTS = 2
const YT_DLP_SEARCH_RESULTS = 5
const YOUTUBE_ID = /^[\w-]{11}$/

// one "id<TAB>title<TAB>channel<TAB>duration" line per result
// a search that hangs mustn't hold its yt-dlp process forever
const YT_DLP_SEARCH_TIMEOUT_MS = 30_000

function searchWithYtDlpLines (query) {
  return runYtDlp(
    [
      '--flat-playlist',
      '--print',
      '%(id)s\t%(title)s\t%(channel)s\t%(duration)s',
      `ytsearch${YT_DLP_SEARCH_RESULTS}:${query}`
    ],
    { signal: AbortSignal.timeout(YT_DLP_SEARCH_TIMEOUT_MS) }
  )
}

// "Search wider" clicks add up fast: at most this many of their searches run
// at once across the whole server, the rest wait their turn
const MAX_SEARCHES_IN_FLIGHT = 4
let searchesInFlight = 0
const waitingSearches = []

async function withSearchSlot (run) {
  if (searchesInFlight < MAX_SEARCHES_IN_FLIGHT) searchesInFlight++
  else await new Promise((resolve) => waitingSearches.push(resolve))

  try {
    return await run()
  } finally {
    const next = waitingSearches.shift()
    if (next) next() // the slot passes straight to the next waiting search
    else searchesInFlight--
  }
}

// only real videos can be downloaded or picked (not playlists or channels)
function hasYoutubeId (video) {
  return YOUTUBE_ID.test(video.videoId)
}

// yt-dlp prints "NA" for a field it doesn't know
function knownField (value) {
  return value && value !== 'NA' ? value : ''
}

function parseYtDlpResults (text) {
  return String(text)
    .split('\n')
    .map((line) => line.split('\t').map((field) => field.trim()))
    .map(([videoId, title, channel, duration]) =>
      normalizeVideo({
        videoId,
        title: knownField(title),
        channel: knownField(channel),
        durationSec: Number(duration) || null
      })
    )
    .filter(hasYoutubeId)
}

async function searchVideos (query, { search = yts, searchWithYtDlp = searchWithYtDlpLines } = {}) {
  for (let attempt = 1; attempt <= YT_SEARCH_ATTEMPTS; attempt++) {
    try {
      const results = await search(query)
      const videos = (results?.videos || []).map(normalizeVideo).filter(hasYoutubeId)
      if (videos.length) return videos
    } catch (err) {
      console.log(`yt-search failed for "${query}":`, err.message)
    }
  }

  try {
    const videos = parseYtDlpResults(await searchWithYtDlp(query))
    if (videos.length) console.log(`Found "${query}" with yt-dlp's search`)
    return videos
  } catch (err) {
    console.log(`yt-dlp search failed for "${query}":`, err.message)
    return []
  }
}

// Does this iTunes result actually look like our track? Loose queries return
// plausible-looking wrong songs, and a wrong cover is worse than no cover.
function itunesResultMatches (result, title, artists, album) {
  const wantTitle = looseText(title)
  const gotTitle = looseText(result.trackName || '')
  if (!wantTitle || !gotTitle) return false

  const titleOk = gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)
  if (!titleOk) return false

  const gotArtist = looseText(result.artistName || '')
  const artistOk = artists.some((a) => gotArtist.includes(a))

  const wantAlbum = looseText(album)
  const gotAlbum = looseText(result.collectionName || '')
  const albumOk = Boolean(wantAlbum) && gotAlbum.includes(wantAlbum)

  return artistOk || albumOk
}

// iTunes allows about 20 lookups a minute, which many songs in parallel go
// over; it then refuses with 403 or 429 for a while, and asking again only
// drags that out. So leave it alone for a minute: meanwhile songs get the
// YouTube thumbnail as their cover.
const ITUNES_BACKOFF_MS = 60 * 1000
const ITUNES_LIMIT_STATUSES = new Set([403, 429])
let itunesPausedUntil = 0

async function searchItunes (term, { fetchFn = fetch, now = Date.now } = {}) {
  if (now() < itunesPausedUntil) return []

  const url =
    'https://itunes.apple.com/search?term=' +
    encodeURIComponent(term) +
    '&entity=song&limit=5'
  const res = await fetchFn(url)
  if (ITUNES_LIMIT_STATUSES.has(res.status)) {
    pauseItunes(res.status, now())
    return []
  }
  if (!res.ok) return []
  const json = await res.json()
  return json.results || []
}

// Several lookups are in flight at once, so several refusals arrive
// together: only the first one starts (and logs) the pause.
function pauseItunes (status, now) {
  if (now < itunesPausedUntil) return
  itunesPausedUntil = now + ITUNES_BACKOFF_MS
  console.log(`iTunes is limiting lookups (HTTP ${status}), using YouTube thumbnails for a minute`)
}

// for tests: forget any pause
function resetItunesBackoff () {
  itunesPausedUntil = 0
}

async function downloadTo (url, filePath) {
  const res = await fetch(url)
  if (!res.ok) return false
  const buffer = Buffer.from(await res.arrayBuffer())
  await fs.promises.writeFile(filePath, buffer)
  return true
}

// centre-crop an image to a square and resize to 600x600
function squareCrop (inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-v', 'error',
      '-i', inputPath,
      '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=600:600',
      outputPath
    ])
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('ffmpeg crop exited ' + code))
    )
    ff.on('error', reject)
  })
}

// 2) Fetch square album art: iTunes first (real cover), YouTube thumbnail as
// a fallback (usually the cover on a blurred background for "Topic" uploads,
// otherwise a frame from the video)
async function fetchAlbumArt ({ title, artist, album, video }, tempFolder, fileBase) {
  const coverPath = `${tempFolder}/${fileBase}_cover.jpg`
  const artists = splitArtists(artist)

  try {
    // iTunes can't cope with the full comma-joined artist list, so search a
    // few narrower ways and take the first result that verifiably matches
    const terms = [
      `${title} ${artists[0] || ''}`.trim(),
      album ? `${title} ${album}` : null,
      title
    ].filter(Boolean)

    for (const term of terms) {
      const results = await searchItunes(term)
      const hit = results.find((r) => itunesResultMatches(r, title, artists, album))
      if (!hit || !hit.artworkUrl100) continue

      // artworkUrl100 is 100x100; the same path serves larger squares
      const artUrl = hit.artworkUrl100.replace(/100x100bb\.jpg$/, '600x600bb.jpg')
      if (await downloadTo(artUrl, coverPath)) return coverPath
    }

    console.log(`No iTunes match for "${title}", using the YouTube thumbnail`)

    if (!video) return null

    const rawPath = `${tempFolder}/${fileBase}_thumb.jpg`
    const thumbUrls = [
      `https://i.ytimg.com/vi/${video.videoId}/maxresdefault.jpg`,
      video.image,
      video.thumbnail
    ].filter(Boolean)

    for (const url of thumbUrls) {
      if (!(await downloadTo(url, rawPath))) continue
      await squareCrop(rawPath, coverPath)
      await fs.promises.rm(rawPath, { force: true })
      return coverPath
    }

    return null
  } catch (err) {
    console.log('Error fetching album art:', err.message || err)
    return null
  }
}

// The calls that reach out to YouTube and iTunes, the Mac's keep-awake and
// the waits before a failed download is tried again, kept on one object so
// tests can stand in for them and run offline (and without waiting)
const services = {
  searchVideos,
  downloadMP3,
  fetchAlbumArt,
  // one for the whole server: jobs running at once share one caffeinate
  keepAwake: createKeepAwake(),
  retryDelaysMs: DEFAULT_DELAYS_MS
}

// 3) Use ffmpeg to apply metadata + optional cover art
function applyMetadataAndCover (mp3Path, coverPath, meta) {
  return new Promise((resolve, reject) => {
    // Make sure the temp file still ends in .mp3 so ffmpeg knows the format
    const tempOut = mp3Path.replace(/\.mp3$/i, '.tagged.mp3')

    const args = []

    // overwrite output if exists
    args.push('-y')

    // INPUTS
    args.push('-i', mp3Path) // audio
    if (coverPath) {
      args.push('-i', coverPath) // cover image
    }

    // MAPS
    if (coverPath) {
      // map audio & image
      args.push('-map', '0:a')
      args.push('-map', '1:v')
    } else {
      args.push('-map', '0:a')
    }

    // copy streams, don't re-encode
    args.push('-c', 'copy')

    // ensure proper ID3v2 + write ID3v1 for older players/iPods
    args.push('-id3v2_version', '3')
    args.push('-write_id3v1', '1')

    // metadata from CSV
    if (meta.title) args.push('-metadata', `title=${meta.title}`)
    if (meta.artist) args.push('-metadata', `artist=${meta.artist}`)
    if (meta.album) args.push('-metadata', `album=${meta.album}`)
    if (meta.genre) args.push('-metadata', `genre=${meta.genre}`)
    // "7/500": players and car stereos that sort by track number play the
    // playlist in the CSV's order
    if (meta.track) args.push('-metadata', `track=${meta.track}`)

    if (meta.year) {
      // ffmpeg's mp3 muxer maps "date" onto the ID3 year frame (TYER/TDRC);
      // a bare "year=" key is dropped, so write both for wide player support
      args.push('-metadata', `date=${meta.year}`)
      args.push('-metadata', `TYER=${meta.year}`)
    }

    // extra tags for cover
    if (coverPath) {
      args.push('-metadata:s:v', 'title=Album cover')
      args.push('-metadata:s:v', 'comment=Cover (front)')
    }

    // OUTPUT
    args.push(tempOut)

    const ff = spawn('ffmpeg', args)

    ff.stderr.on('data', (d) => {
      // ffmpeg logs – useful for debugging
      process.stderr.write(d.toString())
    })

    ff.on('close', (code) => {
      if (code === 0) {
        // Replace original file with tagged version
        fs.promises
          .rename(tempOut, mp3Path)
          .then(async () => {
            // clean up cover file once we've embedded it
            if (coverPath) {
              try {
                await fs.promises.unlink(coverPath)
              } catch (e) {
                // ignore delete errors
              }
            }
            resolve()
          })
          .catch(reject)
      } else {
        // clean up temp on error
        fs.promises
          .unlink(tempOut)
          .catch(() => {})
          .finally(() => {
            reject(new Error('ffmpeg exited with code ' + code))
          })
      }
    })

    ff.on('error', (err) => reject(err))
  })
}

// What the page sees when it polls a job. `after` is the last event number
// the page already has, so each poll only carries the new ✓/✗/? lines.
function publicJob (job, { after = 0 } = {}) {
  const now = Date.now()
  const elapsedMs = activeElapsedMs(job, now)
  const active = Object.values(job.active)
    .sort((a, b) => a.number - b.number)
    .map((song) => publicActiveSong(song, now))

  return {
    id: job.id,
    status: job.status, // running | ready (ZIP waiting) | saved (in folder) | error
    total: job.total,
    done: job.done,
    downloaded: job.mp3s.length,
    zipBytes: job.zipBytes,
    failures: job.failures.slice(0, 20),
    error: job.error,
    saveFolder: job.outputFolder, // null when the result is a ZIP download

    name: job.name, // the playlist (the CSV's file name), or "<name> (picked)"
    parallel: job.parallel, // the limit right now: it can change mid-run
    control: job.control, // run | pause | stop

    // live tracker
    active,
    activeCount: active.length,
    savedCount: job.savedCount, // songs copied from another playlist included
    skippedCount: job.skippedCount,
    reusedCount: job.reusedCount, // of the saved songs, the ones copied in
    savedBytes: job.savedBytes,
    elapsedMs,
    // from the time a song takes lately and the songs at once, so it holds
    // still between songs and the page can count it down
    etaMs: estimateRemainingMsRecent({
      songTimes: job.songTimes,
      activeAges: Object.values(job.active).map((song) => now - song.startedAt),
      done: job.done,
      total: job.total,
      elapsedMs,
      parallel: job.parallel,
      firstBatch: job.firstBatch ?? 1
    }),
    estimatedTotalBytes: estimateTotalBytes({
      savedBytes: job.savedBytes,
      savedCount: job.savedCount,
      done: job.done,
      total: job.total
    }),
    events: job.events.filter((e) => e.seq > after),

    // the page's charts, and its list of the songs that finished last
    history: thinEvenly(job.history, MAX_HISTORY_SENT),
    recent: job.recent.slice(-MAX_RECENT_SENT).reverse(), // newest first

    // the run's options as it uses them (see optionsInEffect), whether this
    // run is keeping the Mac awake right now, and the .m3u written at the end
    options: job.options,
    keepingAwake: isKeepingAwake(job),
    playlistFile: job.playlistFile,

    // songs with no sure YouTube match (or whose download failed): the count
    // while the run goes on, the list itself once it's over
    reviewCount: job.reviews.length,
    ...(job.status === 'running' ? {} : { reviews: reviewsInOrder(job) })
  }
}

// A song being worked on, as the page sees it. One waiting to be tried again
// says how long is left of the wait, so every poll counts it down.
function publicActiveSong (song, now) {
  const { retryAt, ...details } = song
  return retryAt == null ? details : { ...details, retryInMs: Math.max(0, retryAt - now) }
}

// --- live tracker bookkeeping ---

// A running job's history, for the page's charts: a point every 2 s, an
// hour's worth at full detail (after that, older points are thinned), and no
// more points per poll than a chart can use
const HISTORY_SAMPLE_MS = 2000
const MAX_HISTORY_POINTS = 1800
const MAX_HISTORY_SENT = 120

// the songs that finished last: how many are kept, and how many a poll carries
const MAX_RECENT_KEPT = 50
const MAX_RECENT_SENT = 12

// what a row the CSV gives no title or artist for fails with
const NO_TITLE_OR_ARTIST = 'Row with no title/artist'

function addEvent (job, text) {
  job.events.push({ seq: job.events.length + 1, text })
}

function noteFailure (job, text) {
  job.failures.push(text)
  addEvent(job, `✗ ${text}`)
}

// A song now in its folder, downloaded or copied in: counted as saved, and
// remembered under its song number (for the playlist file). Returns its size.
async function countSaved (job, song, finalPath) {
  // the song is already in place, so a failed size check mustn't turn it into a ✗
  const size = await fs.promises.stat(finalPath).then(
    (stat) => stat.size,
    (err) => {
      console.log(`Could not read the size of ${finalPath}:`, err.message)
      return 0
    }
  )
  const fileName = path.basename(finalPath)
  job.savedBytes += size
  job.savedCount++
  job.savedFiles = [...job.savedFiles, fileName]
  job.savedNumbers = [...job.savedNumbers, song.number]
  job.savedFileOf = { ...job.savedFileOf, [song.number]: fileName }
  return size
}

async function noteSaved (job, song, finalPath) {
  const size = await countSaved(job, song, finalPath)
  addEvent(job, `✓ ${path.basename(finalPath, '.mp3')} — ${formatBytes(size)}`)
  noteOutcome(job, song, { outcome: 'saved', bytes: size })
}

// A song copied in from another playlist folder ("World"): saved, and reused
async function noteReused (job, song, finalPath, fromFolder) {
  const size = await countSaved(job, song, finalPath)
  const reason = `copied from ${fromFolder}`
  job.reusedCount++
  addEvent(job, `↺ ${song.title} — ${reason}`)
  noteOutcome(job, song, { outcome: 'reused', bytes: size, reason })
}

// One more song worked through. One that was searched for or downloaded also
// tells the time left how long a song takes: `startedAt` is when it was
// started on (wall clock: a song keeps going while the run is paused), and
// it's noted with when it finished on the run's own clock. One copied in
// from another playlist, or with nothing to search for, took no download
// time, so it has none (songs skipped as already saved never get here).
function noteDone (job, { startedAt }) {
  job.done++
  if (startedAt == null) return
  const now = Date.now()
  job.songTimes = [...job.songTimes, { at: activeElapsedMs(job, now), tookMs: now - startedAt }]
}

// How a song ended, for the page's list of the songs that finished last.
// `tookMs` runs from when the song was started on, so it's null for one that
// never was (skipped as already saved, or a row with nothing to search for).
function noteOutcome (job, song, { outcome, bytes = null, reason = null }) {
  const startedAt = job.active[song.number]?.startedAt
  const entry = {
    number: song.number,
    title: song.title,
    artist: song.artist,
    outcome, // saved | reused | skipped | review | failed
    bytes, // a saved (or reused) song's size
    tookMs: startedAt == null ? null : Date.now() - startedAt,
    reason // why it's on the review list, why it failed, or where it was copied from
  }
  job.recent = [...job.recent, entry].slice(-MAX_RECENT_KEPT)
}

// Where the run is right now, as a point on the page's charts. Its speed is
// what was saved over the last 30 s (throughputBps).
function historyPoint (job) {
  const t = activeElapsedMs(job, Date.now())
  return {
    t,
    done: job.done,
    savedBytes: job.savedBytes,
    speedBps: throughputBps(job.history, { t, savedBytes: job.savedBytes }),
    active: Object.keys(job.active).length,
    parallel: job.parallel
  }
}

function recordHistoryPoint (job) {
  job.history = addHistoryPoint(job.history, historyPoint(job), MAX_HISTORY_POINTS)
}

// Sample the run from when its downloads begin. A paused run's clock stands
// still, so sampling it then would only stack points on the same moment.
function startHistory (job) {
  const sample = () => {
    if (job.control !== 'pause') recordHistoryPoint(job)
  }
  sample()
  job.historyTimer = setInterval(sample, HISTORY_SAMPLE_MS)
  job.historyTimer.unref() // a job's charts mustn't keep the process alive
}

// The run is over: one last point, where it ended, and no more
function stopHistory (job) {
  if (!job.historyTimer) return // its downloads never began
  clearInterval(job.historyTimer)
  job.historyTimer = null
  recordHistoryPoint(job)
}

// The run leaves "running" for good: ready (a ZIP to fetch), saved, or error.
// Its index of songs to reuse goes too: the record lingers for a while, and
// the index can hold thousands of songs.
function endRun (job, status) {
  stopHistory(job)
  job.status = status
  job.endedAt = Date.now()
  job.library = null
}

// The songs being worked on right now, keyed by their number in the CSV.
// Each change makes a new object rather than editing the old one.
function setActive (job, number, details) {
  job.active = { ...job.active, [number]: details }
}

function updateActive (job, number, changes) {
  if (!job.active[number]) return
  job.active = { ...job.active, [number]: { ...job.active[number], ...changes } }
}

function clearActive (job, number) {
  const { [number]: _finished, ...stillRunning } = job.active
  job.active = stillRunning
}

// --- review list: songs without a sure YouTube match ---

// how many of a song's search results the review list offers
const MAX_REVIEW_CANDIDATES = 6

// why a song is on the review list, and the end of its "?" tracker line
const NOT_FOUND = { reason: 'Not found on YouTube', event: 'not found on YouTube' }
const NO_EXACT_MATCH = { reason: 'No exact match on YouTube', event: 'no exact match on YouTube' }
const DOWNLOAD_FAILED = 'Download failed: '
// a picked song that Stop cut short, or that never started
const STOPPED_PICK = 'Not downloaded: stopped'
// a picked song a failed run didn't deliver (the job's error says why)
const FAILED_RUN_PICK = 'Not downloaded: the run failed'

const NO_EXACT_MATCH_MESSAGE =
  'None of the songs had an exact match. Pick the right versions in the review list.'

function isHttpsUrl (value) {
  return typeof value === 'string' && value.startsWith('https://')
}

// A ranked search result, in the shape the page's review table reads
function toCandidate (video) {
  return {
    videoId: video.videoId,
    url: video.url,
    title: video.title,
    channel: video.channel,
    durationSec: video.durationSec,
    views: video.views,
    // the page shows it as an image, so only ever an https address
    thumbnail: isHttpsUrl(video.thumbnail)
      ? video.thumbnail
      : `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
    score: video.score,
    label: video.label,
    variant: video.variant
  }
}

// Put a song on the review list with search results to choose from. `event`
// adds a "?" line to the tracker (a failed download has its ✗ line already).
function listForReview (job, song, { reason, candidates, event }) {
  const item = {
    number: song.number,
    title: song.title,
    artist: song.artist,
    album: song.album || '',
    year: song.year || '',
    genre: song.genre || '',
    durationSec: song.durationSec ?? null,
    reason,
    candidates: candidates.slice(0, MAX_REVIEW_CANDIDATES).map(toCandidate)
  }
  job.reviews = [...job.reviews, item]
  if (event) addEvent(job, `? ${song.title} — ${song.artist}: ${event}`)
}

// A song this run worked on that ends up on the review list: listed there,
// and shown among the songs that finished last. (Picks a stopped or failed
// run never got to are listed without this: they didn't finish.)
function noteReview (job, song, details) {
  listForReview(job, song, details)
  noteOutcome(job, song, { outcome: 'review', reason: details.reason })
}

// songs finish in any order, but the list reads best in playlist order
function reviewsInOrder (job) {
  return [...job.reviews].sort((a, b) => a.number - b.number)
}

// Why a run saved nothing. Songs waiting for the person to pick a version are
// the likeliest reason, and the page shows them right below this message; a
// song whose download failed did have a match, so it doesn't count here.
function emptyRunMessage (job) {
  const hasUnmatchedSongs = job.reviews.some(
    (item) => !item.reason.startsWith(DOWNLOAD_FAILED) && item.reason !== STOPPED_PICK
  )
  if (hasUnmatchedSongs) return NO_EXACT_MATCH_MESSAGE
  return job.control === 'stop'
    ? 'Stopped before any song was saved.'
    : 'No songs could be downloaded.'
}

// One Stop signal for every download in a job. Each running download listens
// to it, so allow that many listeners: past Node's default of 10 it would warn
// about a "possible memory leak" at 11-20 downloads at once.
const LISTENERS_PER_DOWNLOAD = 2 // yt-dlp's own spawn plus our wait on it
function stopSignalFor (parallel) {
  const controller = new AbortController()
  setMaxListeners(Math.max(10, parallel * LISTENERS_PER_DOWNLOAD + 10), controller.signal)
  return controller
}

// Pause, resume or stop a running job. Paused time is kept out of the
// elapsed time, but only from when downloads began: Pause works while the
// run is still getting ready (currentPauseMs). Stopping is final and kills
// the yt-dlp downloads in progress.
function setControl (job, control) {
  if (job.control === 'stop') return
  const now = Date.now()

  if (job.control === 'pause' && control !== 'pause') {
    job.pausedMs += currentPauseMs(job, now)
    job.pausedAt = null
  }
  if (control === 'pause' && job.control !== 'pause') job.pausedAt = now

  job.control = control
  if (control === 'stop') job.abort.abort()
}

// "50" -> 20, "lots" -> 3: how many songs to download at once
function parseParallel (value) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL
  return Math.min(MAX_PARALLEL, Math.max(1, n))
}

// "Download at once" changed mid-run: 5 or "5" -> 5. Unlike the form that
// starts a run, anything but a whole number from 1 to MAX_PARALLEL is refused
// (null) rather than quietly corrected, so the page never shows one limit
// while the run uses another.
function parseParallelChange (value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isInteger(n) && n >= 1 && n <= MAX_PARALLEL ? n : null
}

// Browsers yt-dlp can borrow a YouTube sign-in from (--cookies-from-browser).
// A signed-in browser's cookies get past YouTube's "confirm you're not a bot"
// wall. Off unless the page asks for one; only these exact names reach yt-dlp.
const COOKIE_BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi']

// "" (no sign-in), a known browser name, or null for anything else
function parseCookiesBrowser (value) {
  const browser = String(value ?? '').trim().toLowerCase()
  if (!browser) return ''
  return COOKIE_BROWSERS.includes(browser) ? browser : null
}

const UNKNOWN_BROWSER_ERROR = 'Unknown browser for the YouTube sign-in.'

// The run options the page can turn on or off. /upload gets them as "1" / "0"
// form fields, /picks as true / false; a missing one takes its default.
const OPTION_DEFAULTS = Object.freeze({
  keepAwake: true, // "Keep Mac awake" (caffeinate) while the run goes on
  numberTracks: false, // car-ready: "07 - Title.mp3", so the folder sorts in CSV order
  writePlaylist: true, // car-ready: "<playlist>.m3u" beside the songs
  reuseSongs: true, // copy a song saved in another playlist folder instead of downloading it
  autoRetry: true // try a throttled or cut-off download up to twice more
})
const ON_OFF_VALUES = new Map([
  [true, true],
  [1, true],
  ['1', true],
  ['true', true],
  [false, false],
  [0, false],
  ['0', false],
  ['false', false]
])

// true / false for an on/off field, its default when it's missing, or null
// for anything else: refused, so a page bug can't quietly flip an option
function parseOnOff (value, fallback) {
  if (value == null || value === '') return fallback
  const key = typeof value === 'string' ? value.trim().toLowerCase() : value
  return ON_OFF_VALUES.has(key) ? ON_OFF_VALUES.get(key) : null
}

// { options } from a request body's option fields, or { error } naming the
// first one that's neither on nor off
function parseOptions (body) {
  const options = Object.fromEntries(
    Object.entries(OPTION_DEFAULTS).map(([name, fallback]) => [name, parseOnOff(body?.[name], fallback)])
  )
  const bad = Object.keys(options).find((name) => options[name] === null)
  return bad ? { error: `${bad} must be on or off: "1" or "0" (true or false).` } : { options }
}

// The options a run actually uses. Numbering, the playlist file and reusing
// songs are about a playlist folder, so a ZIP run has none of them. The
// playlist file and reusing songs also need the whole CSV: a "Download
// selected" run only has the picks, and the person chose those videos.
function optionsInEffect (options, { isFolder, isCsvRun }) {
  return {
    ...options,
    numberTracks: options.numberTracks && isFolder,
    writePlaylist: options.writePlaylist && isFolder && isCsvRun,
    reuseSongs: options.reuseSongs && isFolder && isCsvRun
  }
}

async function removeJob (job) {
  jobs.delete(job.id)
  clearTimeout(job.expiry)
  await fs.promises.rm(job.tempFolder, { recursive: true, force: true })
}

// The folder stays taken until the job has tidied it up, so a new run there
// can't have its own work folder swept away by this one's clean-up. A new run
// waits for that (takeOutputFolder): the page already shows this one as over.
function failJob (job, message) {
  console.log(message)
  keepUndeliveredPicks(job)
  endRun(job, 'error')
  job.error = message
  const tidiedUp = cleanUpWorkFiles(job)
    .catch((err) => console.log('Could not clean up after the job:', err.message))
    .finally(() => releaseFolder(job))
  if (job.claimedFolder) foldersTidying.set(job.claimedFolder, tidiedUp)
  keepRecord(job)
}

// Delete the job's scratch files. In folder mode, songs already saved stay; a
// folder this job made only goes if nothing made it into it, and a folder it
// didn't make (one picked to save into, or an earlier run's) always stays.
async function cleanUpWorkFiles (job) {
  await fs.promises.rm(job.tempFolder, { recursive: true, force: true })
  if (!job.outputFolder) return

  await removeMacLeftovers(job)
  if (!job.madeOutputFolder) return
  // songs waiting in the review list get saved here once picked
  if (job.reviews.length) return
  const left = await fs.promises.readdir(job.outputFolder)
  if (!left.length) await fs.promises.rmdir(job.outputFolder)
}

// Clear the hidden ._ files macOS writes on FAT32 drives. A playlist folder
// only holds this app's songs, so all of them go; a folder picked to save
// into may hold other files, so there only the ._ twins of what this run put
// in it go.
async function removeMacLeftovers (job) {
  if (!job.isExactFolder) return removeMacMetadataFor(job.outputFolder)
  await removeMacTwinsOf(job.outputFolder, [...job.savedFiles, path.basename(job.tempFolder)])
}

// Keep only the job's record, for the page's next poll (about a second away)
// to read the outcome, and for a page reloaded soon after to find the run
// and its review list again (RECORD_TTL_MS). A job that has already vanished
// reads as a server restart ("Lost track of the job") instead.
function keepRecord (job) {
  clearTimeout(job.expiry)
  job.expiry = setTimeout(() => jobs.delete(job.id), RECORD_TTL_MS)
  job.expiry.unref() // a leftover record shouldn't keep the process alive
  dropOldRecords()
}

// a job that only holds its record: failed, or saved to a folder
function isRecordOnly (job) {
  return job.status === 'error' || job.status === 'saved'
}

// Past MAX_RECORDS_KEPT records, the ones that ended first go
function dropOldRecords () {
  const records = [...jobs.values()].filter(isRecordOnly).sort((a, b) => a.endedAt - b.endedAt)
  for (const record of records.slice(0, Math.max(0, records.length - MAX_RECORDS_KEPT))) {
    clearTimeout(record.expiry)
    jobs.delete(record.id)
  }
}

// What GET /jobs says about a run: enough for a reloaded page to pick it out
// and follow it again through /progress
function jobSummary (job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    total: job.total,
    done: job.done,
    saveFolder: job.outputFolder, // null when the result is a ZIP download
    startedAt: job.startedAt, // when its downloads began (epoch ms), or null
    endedAt: job.endedAt, // when it left "running", or null
    isPicks: !isCsvRun(job) // a "Download selected" run of songs from the review list
  }
}

// --- one run per folder ---

// How a folder's path is compared: as the drive does (case and accents)
function folderKey (folder) {
  return nameKey(path.resolve(folder))
}

// Take `folder` for a job: returns its key, for the job to release once it's
// over. Throws a 409 error when another running job has it. Synchronous, so
// two requests can't both pass the check.
function claimFolder (folder) {
  const key = folderKey(folder)
  if (foldersInUse.has(key)) {
    throw Object.assign(new Error(FOLDER_IN_USE_ERROR), { status: 409 })
  }
  foldersInUse.add(key)
  return key
}

// Once only: by then another run may have taken the folder
function releaseFolder (job) {
  if (job.claimedFolder) {
    foldersInUse.delete(job.claimedFolder)
    foldersTidying.delete(job.claimedFolder)
  }
  job.claimedFolder = null
}

// The folder a job saves into (prepareOutputFolder, plus claimedFolder: its
// key, taken so no other run saves there at the same time), cleared of the
// work folders an interrupted run left in it
async function takeOutputFolder (where) {
  const sharedFolder = sharedFolderOf(where)
  // a run that just failed there may still be tidying up: wait, don't refuse
  const tidying = sharedFolder && foldersTidying.get(folderKey(sharedFolder))
  if (tidying) await tidying
  const claim = { claimedFolder: sharedFolder ? claimFolder(sharedFolder) : null } // no await between check and claim
  try {
    const prepared = await prepareOutputFolder(where)
    if (prepared.outputFolder && !sharedFolder) claim.claimedFolder = claimFolder(prepared.outputFolder)
    if (sharedFolder) await removeLeftoverWorkFolders(prepared.outputFolder)
    return { ...prepared, claimedFolder: claim.claimedFolder }
  } catch (err) {
    releaseFolder(claim)
    throw err
  }
}

// The folder a new job would save into, when that can be a folder already
// in use: a picked folder, or a playlist folder reused to skip the songs
// already in it. null for a ZIP, or a new playlist folder (always a fresh one).
function sharedFolderOf ({ saveTo, name, skipExisting, exactFolder }) {
  if (exactFolder) return exactFolder
  if (saveTo && skipExisting) return path.join(saveTo, name)
  return null
}

// Hidden work folders a run left behind when the server was stopped or
// restarted mid-run, with its half-downloaded songs: no other run is saving
// into this folder (claimFolder), so they're nobody's. A failure is logged:
// it's no reason not to start.
async function removeLeftoverWorkFolders (folder) {
  try {
    const names = await fs.promises.readdir(folder)
    await Promise.all(
      names
        .filter((name) => name.startsWith(WORK_FOLDER_PREFIX))
        .map((name) => fs.promises.rm(path.join(folder, name), { recursive: true, force: true }))
    )
  } catch (err) {
    console.log(`Could not clear old work folders in ${folder}:`, err.message)
  }
}

// "My Playlist.csv" -> "My Playlist"
function playlistFolderName (csvName) {
  return makeFileBaseFromTitle(path.parse(String(csvName || '')).name) || 'ZipifyTunes'
}

// The folder a job saves into, and whether the job made it (only then may it
// remove the folder again when nothing was saved). With skipExisting, the
// playlist's folder from an earlier run is reused (so songs already there can
// be skipped) instead of making "<name> (2)". A folder picked for picked
// songs (exactFolder) is used as it is, with no new folder inside.
async function prepareOutputFolder ({ saveTo, name, skipExisting, exactFolder }) {
  if (exactFolder) return { outputFolder: exactFolder, madeOutputFolder: false }
  if (!saveTo) return { outputFolder: null, madeOutputFolder: false }
  if (!skipExisting) {
    return { outputFolder: await makeUniqueFolder(saveTo, name), madeOutputFolder: true }
  }

  const existed = await fs.promises.stat(path.join(saveTo, name)).then(() => true, () => false)
  return { outputFolder: await openFolder(saveTo, name), madeOutputFolder: !existed }
}

// A ZIP job works in mp3s_<id>/ next to the server. A folder job works in a
// hidden folder inside the folder it saves into, so the audio only ever lands
// on the chosen drive and finished songs move into place with a cheap rename.
// `name` names the job (the ZIP) when there's no CSV to name it after;
// `picks` are the songs picked on the review list, each with its video;
// `options` are the run options in effect (optionsInEffect).
async function createJob (
  trackCount,
  { saveTo, csvName, name, exactFolder, skipExisting, parallel, cookiesBrowser = '', picks = [], options }
) {
  // random, so no other website can guess a job and fetch or spoil its ZIP
  const id = randomUUID()
  const jobName = name || playlistFolderName(csvName)
  const { outputFolder, madeOutputFolder, claimedFolder } = await takeOutputFolder({
    saveTo,
    name: jobName,
    skipExisting,
    exactFolder
  })

  const job = {
    id,
    status: 'running',
    total: trackCount,
    done: 0,
    mp3s: [],
    zipBytes: 0,
    failures: [],
    error: null,
    tempFolder: outputFolder
      ? path.join(outputFolder, WORK_FOLDER_PREFIX + id.slice(0, 8))
      : 'mp3s_' + id,
    outputFolder,
    isExactFolder: Boolean(exactFolder),
    madeOutputFolder,
    // the folder this job keeps other runs out of (claimFolder), until it's over
    claimedFolder,
    expiry: null,
    name: jobName,
    skipExisting: Boolean(skipExisting),
    parallel, // "Download at once"; POST /jobs/:id/parallel changes it mid-run
    cookiesBrowser, // '' = no YouTube sign-in
    options,
    // the keep-awake this run holds while it goes on (holdAwakeFor)
    heldKeepAwake: null,
    // a promise of the index of songs to reuse, on a reuseSongs run
    library: null,
    // the .m3u written when the run ended
    playlistFile: null,
    // Pause / Resume / Stop
    control: 'run',
    // sized for the most downloads a run can reach, since the limit can be
    // raised while it goes on
    abort: stopSignalFor(MAX_PARALLEL),
    pausedAt: null,
    pausedMs: 0,
    // live tracker
    startedAt: null, // set once downloads begin
    endedAt: null, // set once the run leaves "running"
    // how many songs started together when the downloads began: until that
    // many are through, there's no telling how long a song takes
    firstBatch: null,
    active: {},
    reservedNames: new Set(),
    savedBytes: 0,
    savedCount: 0,
    savedFiles: [], // names of the MP3s this run saved
    savedNumbers: [], // and the CSV rows (song numbers) they came from
    savedFileOf: {}, // song number -> the name it was saved under
    reusedCount: 0, // of the saved songs, the ones copied from another playlist
    skippedCount: 0,
    listedTwiceCount: 0, // of the skipped songs, rows repeating an earlier row's song
    events: [],
    // when each song worked on finished and how long it took (for the time
    // left), the run's history (for the page's charts) and the songs that
    // finished last
    songTimes: [],
    history: [],
    historyTimer: null,
    recent: [],
    // songs with no sure match, for the person to pick versions of
    reviews: [],
    // a failed run puts the picks it didn't deliver back on the review list
    picks
  }

  try {
    await fs.promises.mkdir(job.tempFolder)
  } catch (err) {
    releaseFolder(job)
    // don't leave an empty playlist folder behind on the drive
    if (madeOutputFolder) {
      await fs.promises.rmdir(outputFolder).catch((rmErr) =>
        console.log(`Could not remove ${outputFolder}:`, rmErr.message)
      )
    }
    throw err
  }

  jobs.set(id, job)
  return job
}

function readCsv (csvPath) {
  return new Promise((resolve, reject) => {
    const rows = []
    fs.createReadStream(csvPath)
      .on('error', reject)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('error', reject)
      .on('end', () => resolve(rows))
  })
}

// Poll a job's progress
app.get('/progress', (req, res) => {
  const job = jobs.get(req.query.job)
  if (!job) return res.status(404).json({ error: 'Unknown job' })
  res.json(publicJob(job, { after: Number(req.query.after) || 0 }))
})

// The runs this server knows of, newest first: the ones still going, and
// finished ones whose record is still kept (RECORD_TTL_MS). A page reloaded
// mid-run finds its run here to follow (and pause, stop…) again; one
// reloaded soon after a run, the run to collect its review list from.
app.get('/jobs', (req, res) => {
  res.json({ jobs: [...jobs.values()].reverse().map(jobSummary) })
})

// { "parallel": 5 } is all a new "Download at once" sends
const readParallelBody = express.json({ limit: '1kb' })

// Change "Download at once" while the run goes on: a higher limit starts more
// songs within a moment, a lower one lets the songs already running finish
// and starts no new one until fewer than that are running. Answers with the
// job, as /progress would. (Registered before the route below, which would
// otherwise read "parallel" as an unknown action.)
app.post('/jobs/:id/parallel', readParallelBody, jsonBodyError, (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Unknown job' })

  const parallel = parseParallelChange(req.body?.parallel)
  if (parallel === null) return res.status(400).json({ error: PARALLEL_RANGE_ERROR })
  if (job.status !== 'running') return res.status(409).json({ error: RUN_FINISHED_ERROR })

  job.parallel = parallel
  res.json(publicJob(job))
})

// Pause / resume / stop a running job
app.post('/jobs/:id/:action', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Unknown job' })

  const { action } = req.params
  if (!Object.hasOwn(CONTROL_ACTIONS, action)) {
    return res.status(400).json({ error: `Unknown action: ${action}` })
  }
  if (job.status !== 'running') {
    return res.status(409).json({ error: RUN_FINISHED_ERROR })
  }

  setControl(job, CONTROL_ACTIONS[action])
  res.json(publicJob(job))
})

// Start a job: parse the CSV, kick off the downloads, return the job id
// (an optional "saveTo" folder saves the MP3s there instead of making a ZIP)
app.post('/upload', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file was uploaded.' })
  }

  try {
    const cookiesBrowser = parseCookiesBrowser(req.body.cookiesBrowser)
    if (cookiesBrowser === null) return res.status(400).json({ error: UNKNOWN_BROWSER_ERROR })
    const { options, error: optionsError } = parseOptions(req.body)
    if (optionsError) return res.status(400).json({ error: optionsError })

    const saveTo = String(req.body.saveTo || '').trim()
    const folderProblem = saveTo ? await checkSaveFolder(saveTo) : null
    if (folderProblem) return res.status(400).json({ error: folderProblem })

    const allRows = await readCsv(req.file.path).catch((err) => {
      res.status(400).json({ error: 'Could not parse CSV: ' + err.message })
      return null
    })
    if (!allRows) return
    const rows = allRows.filter(hasAnyValue)
    if (!rows.length) {
      return res.status(400).json({ error: 'The CSV had no rows.' })
    }

    const job = await createJob(rows.length, {
      saveTo,
      csvName: req.file.originalname,
      skipExisting: saveTo !== '' && req.body.skipExisting === '1',
      parallel: parseParallel(req.body.parallel),
      cookiesBrowser,
      options: optionsInEffect(options, { isFolder: saveTo !== '', isCsvRun: true })
    })
    res.json({ jobId: job.id })
    startJob(job, songsFromRows(rows), req.body.quality)
  } catch (err) {
    answerStartError(res, err, 'Could not start the job:')
  } finally {
    // the CSV is in memory (or rejected) by now
    fs.promises.rm(req.file.path, { force: true }).catch(() => {})
  }
})

// A blank CSV row (an empty line, or Excel's ",,") is no song at all: left
// out before the songs are numbered, rather than failing as one
function hasAnyValue (row) {
  return Object.values(row).some((value) => String(value ?? '').trim() !== '')
}

// Why a job couldn't start: a folder another run is saving into (409, with
// its own message), or anything else (500)
function answerStartError (res, err, logPrefix) {
  if (err.status === 409) return res.status(409).json({ error: err.message })
  console.log(logPrefix, err)
  res.status(500).json({ error: 'Could not start: ' + err.message })
}

// Run a job in the background: the request that started it has already been
// answered with the job id, and the page follows along through /progress
function startJob (job, songs, quality) {
  runHoldingAwake(job, songs, quality || '0').catch((err) =>
    console.log(`Job ${job.id} could not be wound up:`, err)
  )
}

// With "Keep Mac awake" the run holds the Mac awake from start to end, and
// lets go however it ends: saved, ZIP ready, failed or stopped
async function runHoldingAwake (job, songs, quality) {
  const release = holdAwakeFor(job)
  try {
    await runJob(job, songs, quality)
  } catch (err) {
    failJob(job, 'Unexpected error: ' + (err.message || err))
  } finally {
    release()
  }
}

// Acquire the server's keep-awake for this run, when it asks for that.
// Returns the release. A Mac that may sleep is no reason to fail the run, so
// a keep-awake that breaks is only logged.
function holdAwakeFor (job) {
  if (!job.options.keepAwake) return () => {}
  const { keepAwake } = services // this one, even if another is swapped in mid-run
  try {
    const release = keepAwake.acquire(`job ${job.id.slice(0, 8)}`)
    job.heldKeepAwake = keepAwake
    return () => {
      job.heldKeepAwake = null
      release()
    }
  } catch (err) {
    console.log('Could not keep the Mac awake:', err.message)
    return () => {}
  }
}

// For the page: this running job holds the keep-awake, and caffeinate is on
function isKeepingAwake (job) {
  return job.status === 'running' && Boolean(job.heldKeepAwake?.isActive())
}

// --- the review list's requests: other versions of a song, downloading picks ---

const MAX_SONG_TEXT = 300
const MAX_PICK_NAME = 200
const MAX_PICKS = 1000
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

// "Search wider" pools a few differently worded searches
const ALTERNATIVE_QUERIES = 4
const MAX_ALTERNATIVES = 8

// a 1000-song pick list is well under this; anything bigger is a mistake
const readJsonBody = express.json({ limit: '1mb' })

const BODY_ERRORS = {
  'entity.parse.failed': 'The request body is not valid JSON.',
  'entity.too.large': 'Too much data in one request.'
}

// express.json() turns a body it can't read into an error; answer it in the
// same { error } shape as any other bad request, not Express's HTML page
function jsonBodyError (err, req, res, next) {
  if (!(err.status >= 400 && err.status < 500)) return next(err)
  res.status(err.status).json({
    error: BODY_ERRORS[err.type] || `Could not read the request: ${err.message}`
  })
}

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// text from a JSON field, trimmed; '' when it's missing
function cleanText (value) {
  return value == null ? '' : String(value).trim()
}

// An optional field holding text (or a number, e.g. a year) of at most
// maxLength characters. Returns what's wrong with it, or null.
function optionalTextProblem (value, label, maxLength = Infinity) {
  if (value == null) return null
  if (typeof value !== 'string' && !Number.isFinite(value)) return `${label} must be text.`
  if (cleanText(value).length > maxLength) {
    return `${label} is too long (at most ${maxLength} characters).`
  }
  return null
}

function requiredTextProblem (value, label, maxLength = Infinity) {
  if (!cleanText(value)) return `${label} is missing.`
  return optionalTextProblem(value, label, maxLength)
}

function durationProblem (value, label) {
  if (value == null) return null
  if (!Number.isFinite(value) || value < 0) return `${label} must be a number of seconds.`
  return null
}

// What's wrong with a POST /alternatives body, or null
function wantedSongProblem (body) {
  if (!isPlainObject(body)) return 'Send the song as JSON, with at least a title.'
  return (
    requiredTextProblem(body.title, 'The title', MAX_SONG_TEXT) ||
    optionalTextProblem(body.artist, 'The artist', MAX_SONG_TEXT) ||
    optionalTextProblem(body.album, 'The album', MAX_SONG_TEXT) ||
    durationProblem(body.durationSec, 'The song length')
  )
}

// What's wrong with one picked song ("Song 3"), or null
function pickedSongProblem (song, label) {
  if (!isPlainObject(song)) return `${label} needs a title, an artist and a videoId.`
  const hasVideoId = typeof song.videoId === 'string' && VIDEO_ID.test(song.videoId)
  return (
    requiredTextProblem(song.title, `${label}'s title`) ||
    requiredTextProblem(song.artist, `${label}'s artist`) ||
    optionalTextProblem(song.album, `${label}'s album`) ||
    optionalTextProblem(song.year, `${label}'s year`) ||
    optionalTextProblem(song.genre, `${label}'s genre`) ||
    durationProblem(song.durationSec, `${label}'s length`) ||
    trackProblem(song, label) ||
    (hasVideoId
      ? null
      : `${label}'s videoId is not a YouTube video id (11 letters, digits, - or _).`)
  )
}

function isTrackNumber (value) {
  return Number.isSafeInteger(value) && value >= 1
}

// A picked song may bring its place in its CSV ("number", from 1) and the
// CSV's song count ("trackTotal"), to be numbered and tagged like the CSV's
// own run; they're used once both are there. What's wrong with them, or null.
function trackProblem ({ number, trackTotal }, label) {
  if (number != null && !isTrackNumber(number)) {
    return `${label}'s number must be a whole number from 1.`
  }
  if (trackTotal != null && !isTrackNumber(trackTotal)) {
    return `${label}'s trackTotal must be a whole number from 1.`
  }
  if (number != null && trackTotal != null && number > trackTotal) {
    return `${label}'s number is past its trackTotal.`
  }
  return null
}

// What's wrong with a POST /picks body, or null. The save folder itself is
// checked separately, since that touches the disk.
function picksProblem (body) {
  if (!isPlainObject(body)) return 'Send the picked songs as JSON.'
  const problem =
    requiredTextProblem(body.name, 'The name', MAX_PICK_NAME) ||
    optionalTextProblem(body.saveFolder, 'The save folder') ||
    optionalTextProblem(body.quality, 'The quality')
  if (problem) return problem

  const { songs } = body
  if (!Array.isArray(songs) || !songs.length) return 'Pick at least one song.'
  if (songs.length > MAX_PICKS) return `Pick at most ${MAX_PICKS} songs at a time.`

  for (const [i, song] of songs.entries()) {
    const songProblem = pickedSongProblem(song, `Song ${i + 1}`)
    if (songProblem) return songProblem
  }
  return null
}

// "Search wider" for a song on the review list: a few differently worded
// searches, pooled and ranked against the song, best first
app.post('/alternatives', readJsonBody, jsonBodyError, async (req, res) => {
  const problem = wantedSongProblem(req.body)
  if (problem) return res.status(400).json({ error: problem })

  try {
    const wanted = {
      title: cleanText(req.body.title),
      artist: cleanText(req.body.artist),
      album: cleanText(req.body.album),
      durationSec: req.body.durationSec || null
    }
    const queries = buildSearchQueries(wanted).slice(0, ALTERNATIVE_QUERIES)
    const results = await Promise.all(
      queries.map((query) => withSearchSlot(() => services.searchVideos(query)))
    )
    const ranked = rankAndLabel(results.flat(), wanted)

    res.json({ candidates: ranked.slice(0, MAX_ALTERNATIVES).map(toCandidate) })
  } catch (err) {
    console.log('Could not search for other versions:', err)
    res.status(500).json({ error: 'Could not search YouTube: ' + err.message })
  }
})

// Download the versions picked on the review list. It runs like an upload
// (same /progress, pause / resume / stop, /download), as a ZIP named
// "<name> (picked).zip", or straight into the given folder itself.
app.post('/picks', readJsonBody, jsonBodyError, async (req, res) => {
  const problem = picksProblem(req.body)
  if (problem) return res.status(400).json({ error: problem })
  const cookiesBrowser = parseCookiesBrowser(req.body.cookiesBrowser)
  if (cookiesBrowser === null) return res.status(400).json({ error: UNKNOWN_BROWSER_ERROR })
  const { options, error: optionsError } = parseOptions(req.body)
  if (optionsError) return res.status(400).json({ error: optionsError })

  try {
    const saveFolder = cleanText(req.body.saveFolder)
    const folderProblem = saveFolder ? await checkSaveFolder(saveFolder) : null
    if (folderProblem) return res.status(400).json({ error: folderProblem })

    const songs = songsFromPicks(req.body.songs)
    const job = await createJob(songs.length, {
      name: `${cleanText(req.body.name)} (picked)`,
      exactFolder: saveFolder || null,
      parallel: parseParallel(req.body.parallel),
      cookiesBrowser,
      picks: songs,
      options: optionsInEffect(options, { isFolder: saveFolder !== '', isCsvRun: false })
    })
    res.json({ jobId: job.id })
    startJob(job, songs, req.body.quality)
  } catch (err) {
    answerStartError(res, err, 'Could not start the picked songs:')
  }
})

// connected drives, offered as save folders on the page
app.get('/drives', async (req, res) => {
  try {
    res.json(await listDrives())
  } catch (err) {
    console.log('Could not list drives:', err.message)
    res.json([]) // the page still works with a typed path
  }
})

// Open the system's own folder dialog and hand back what was picked. The
// request stays open until the person picks or cancels.
app.post('/pick-folder', async (req, res) => {
  try {
    const result = await pickFolder()
    if (result.unsupported) {
      return res.status(501).json({
        error: 'There is no folder picker on this system. Type the folder path instead.'
      })
    }
    res.json(result)
  } catch (err) {
    console.log('Folder picker failed:', err.message)
    res.status(500).json({ error: 'Could not open the folder picker: ' + err.message })
  }
})

// the MP3s in a folder, skipping hidden files such as the "._Song.mp3"
// metadata twins macOS writes on FAT32 drives
function listSongFiles (folder) {
  return fs
    .readdirSync(folder)
    .filter((f) => !f.startsWith('.') && f.toLowerCase().endsWith('.mp3'))
}

// The CSV columns this app understands, read from one row
function readSongRow (row) {
  return {
    title: getField(row, [
      'title',
      'Title',
      'track',
      'Track',
      'track_name',
      'Track Name',
      'trackName',
      'name',
      'Name',
      'song',
      'Song'
    ]),
    artist: getField(row, [
      'artist',
      'Artist',
      'artists',
      'Artists',
      'artist_name',
      'Artist Name',
      'artist_names',
      'Artist Name(s)', // Exportify
      'singer',
      'Singer',
      'performer',
      'Performer'
    ]),
    album: getField(row, [
      'album',
      'Album',
      'album_name',
      'Album Name',
      'albumName',
      'record',
      'Record',
      'release',
      'Release'
    ]),
    year: getYear(row),
    genre: getGenre(row),
    durationSec: getDurationSec(row)
  }
}

// The song's length in seconds, or null when the CSV doesn't say. It tells
// the right upload from a live or extended one. Exportify gives milliseconds.
function getDurationSec (row) {
  const fromMs = parseDurationSec(
    getField(row, ['Duration (ms)', 'duration_ms', 'Track Duration (ms)']),
    { fromMs: true }
  )
  return fromMs ?? parseDurationSec(getField(row, ['duration', 'Duration', 'Time', 'Length']))
}

// The songs a CSV asks for, numbered from 1 in file order. Each knows its
// track number ("7 of 500") for its tags and a car-ready file name, and the
// name it's saved under (nameSongs).
function songsFromRows (rows) {
  return nameSongs(
    rows.map((row, i) => ({
      number: i + 1,
      row,
      ...readSongRow(row),
      track: { number: i + 1, total: rows.length }
    }))
  )
}

// The songs picked from the review list (already checked by picksProblem),
// each with the video to download: no search, no match check, the person
// chose it
function songsFromPicks (picks) {
  return nameSongs(songsOfPicks(picks))
}

function songsOfPicks (picks) {
  return picks.map((pick, i) => {
    const title = cleanText(pick.title)
    const artist = cleanText(pick.artist)
    return {
      number: i + 1,
      row: { title, artist }, // what the log names the song by
      title,
      artist,
      album: cleanText(pick.album),
      year: cleanText(pick.year),
      genre: cleanText(pick.genre),
      durationSec: pick.durationSec || null,
      video: normalizeVideo({ videoId: pick.videoId }),
      // picks are numbered 1, 2… here, which says nothing about their place
      // in the playlist: only the CSV number the page sent along does
      track: pickTrack(pick)
    }
  })
}

// a picked song's place in its CSV (checked by trackProblem), or null
function pickTrack ({ number, trackTotal }) {
  return number != null && trackTotal != null ? { number, total: trackTotal } : null
}

// --- the file each song is saved under ---

// why a row repeating an earlier row's song is skipped (its ↷ line, and the
// recent list)
const LISTED_TWICE = 'listed twice in the CSV'

// How the drive compares names: FAT32 and macOS ignore case, and may hand
// accented names back decomposed
function nameKey (name) {
  return String(name).normalize('NFC').toLowerCase()
}

// The spellings to reach a file listed as `name` by: composed (NFC) first,
// as this app writes names and as macOS's FAT32 and exFAT drivers want them
// for a rename or a delete (they list them decomposed), then as listed
function spellingsOf (name) {
  return [...new Set([name.normalize('NFC'), name])]
}

// act(path) on the file listed as `name` in `folder`, by the first spelling
// the drive finds it under (see spellingsOf)
async function onListedFile (folder, name, act) {
  const [composed, listed] = spellingsOf(name)
  try {
    return await act(path.join(folder, composed))
  } catch (err) {
    if (err.code !== 'ENOENT' || listed === undefined) throw err
    return act(path.join(folder, listed))
  }
}

// the song's title as a file name, without ".mp3"
function titleBaseOf (song) {
  return makeFileBaseFromTitle(song.title) || `Track ${song.number}`
}

// The first artist the CSV lists for the song ("Pritam,KK" -> "Pritam"), as
// a file name. Only commas and semicolons part artists here: "Simon &
// Garfunkel" and "AC/DC" are one name each.
function mainArtistBaseOf (song) {
  const first = String(song.artist ?? '').split(/[,;]/).find((name) => name.trim()) ?? ''
  return makeFileBaseFromTitle(first)
}

// Decide, once for a whole CSV (or list of picks), the name each song is
// saved under (fileBase, without ".mp3"), and which rows only repeat an
// earlier row's song (sameSongAs: that row's number). Two different songs
// may share a title ("Babydoll" by Dominic Fike and by Jamie Miller): under
// the title alone, the second would land in "Babydoll (2).mp3" and "skip
// songs already saved" would take the first one's file for it. So a title
// (compared the way the drive compares names) that more than one artist's
// song has is saved as "<title> - <main artist>" (hasSharedTitle). The same
// title by the same main artist is the same song.
function nameSongs (songs) {
  const named = songs.filter((song) => song.title && song.artist)
  const titleKey = (song) => nameKey(titleBaseOf(song))
  const songKey = (song) => `${titleKey(song)}\n${nameKey(mainArtistBaseOf(song) || song.artist)}`
  // title -> the different songs (title and main artist) that have it
  const songsOfTitle = named.reduce((byTitle, song) => {
    const songsSoFar = byTitle.get(titleKey(song)) ?? []
    return byTitle.set(titleKey(song), new Set([...songsSoFar, songKey(song)]))
  }, new Map())
  // each song's first row: later entries win, so the rows go in reversed
  const firstRowOf = new Map([...named].reverse().map((song) => [songKey(song), song.number]))

  return songs.map((song) => {
    const titleBase = titleBaseOf(song)
    if (!song.title || !song.artist) {
      return { ...song, fileBase: titleBase, hasSharedTitle: false, sameSongAs: null }
    }
    const hasSharedTitle = songsOfTitle.get(titleKey(song)).size > 1
    const artistBase = mainArtistBaseOf(song)
    const firstRow = firstRowOf.get(songKey(song))
    return {
      ...song,
      fileBase: hasSharedTitle && artistBase ? shortFileBase(`${titleBase} - ${artistBase}`) : titleBase,
      hasSharedTitle,
      sameSongAs: firstRow === song.number ? null : firstRow
    }
  })
}

// the file name a song is saved under, without ".mp3"
function fileBaseFor (song) {
  return song.fileBase ?? titleBaseOf(song)
}

// The name a song is saved under this run, without ".mp3": "07 - Tum Hi Ho"
// in a car-ready (numbered) folder, else its file base: the title, with the
// artist when another song shares the title (nameSongs)
function saveNameFor (job, song) {
  const fileBase = fileBaseFor(song)
  if (!job.options.numberTracks || !song.track) return fileBase
  return path.basename(numberedFileName(song.track.number, song.track.total, fileBase), '.mp3')
}

// The names a song may already be saved under: numbered (by a car-ready run)
// first, then plain
function savedNamesOf (song) {
  const fileBase = fileBaseFor(song)
  if (!song.track) return [`${fileBase}.mp3`]
  return songFileNames(song.track.number, song.track.total, fileBase)
}

// The MP3s in a folder by nameKey, each with its name as it is
function songFilesByKey (folder) {
  return new Map(listSongFiles(folder).map((name) => [nameKey(name), name]))
}

// "005 - babydoll (2).mp3" -> "babydoll.mp3": a song's name by its title
// alone, without the track number or the " (2)" an earlier version added
// when another song had the name already
function titleOnlyKey (key) {
  return stripTrackPrefix(key).replace(/ \(\d+\)(?=\.mp3$)/, '')
}

// One of the song's artists named in a tag's artist, as whole words ("ali"
// is not "alicia keys")
function hasArtistOf (song, tagArtist) {
  const tagged = ` ${splitArtists(tagArtist ?? '').join(' ')} `
  return splitArtists(song.artist).some((name) => tagged.includes(` ${name} `))
}

// the first of the song's own names that's in the folder and not taken
function ownSavedFile (song, files, claimed) {
  const key = savedNamesOf(song).map(nameKey).find((name) => files.has(name) && !claimed.has(name))
  return key ? files.get(key) : null
}

// A file an earlier version saved this song in under its title alone
// ("Babydoll.mp3", "Babydoll (2).mp3", "005 - Babydoll.mp3"), which only
// happened to a title another song shares: such a file is this song's only
// when its tags name one of the song's artists
async function earlierSavedFile (song, folder, files, claimed) {
  if (!song.hasSharedTitle) return null
  const titleFile = nameKey(`${titleBaseOf(song)}.mp3`)
  const candidates = [...files.keys()]
    .filter((key) => !claimed.has(key) && titleOnlyKey(key) === titleFile)
    .sort()
  for (const key of candidates) {
    const tags = await readTagsOfListed(folder, files.get(key))
    if (tags && hasArtistOf(song, tags.artist)) return files.get(key)
  }
  return null
}

// The tags of the file listed as `name` (readId3Tags never rejects: null
// when unreadable), by the first spelling that reads
async function readTagsOfListed (folder, name) {
  for (const spelling of spellingsOf(name)) {
    const tags = await readId3Tags(path.join(folder, spelling))
    if (tags) return tags
  }
  return null
}

// Which file in `folder` each song is already saved in: song number -> file
// name. Its own names first (savedNamesOf), then a file an earlier version
// named after a shared title alone (earlierSavedFile). No file counts for
// two songs, and a row repeating another row's song has none of its own.
async function findSavedFiles (songs, folder) {
  const files = songFilesByKey(folder)
  const claimed = new Set()
  const found = new Map()
  for (const song of songs) {
    if (!song.title || !song.artist || song.sameSongAs != null) continue
    const fileName =
      ownSavedFile(song, files, claimed) ?? (await earlierSavedFile(song, folder, files, claimed))
    if (!fileName) continue
    claimed.add(nameKey(fileName))
    found.set(song.number, fileName)
  }
  return found
}

// A CSV row with the same title and artist as an earlier row is that song
// again: it's downloaded once, for the first row, and this one is skipped.
// Returns the other songs.
function leaveOutSongsListedTwice (job, songs) {
  if (!isCsvRun(job)) return songs // picks are each the person's own choice
  return songs.filter((song) => {
    if (song.sameSongAs == null) return true

    job.skippedCount++
    job.listedTwiceCount++
    job.done++
    addEvent(job, `↷ ${song.title} — ${LISTED_TWICE}`)
    noteOutcome(job, song, { outcome: 'skipped', reason: LISTED_TWICE })
    return false
  })
}

// With "skip songs already saved", leave out songs whose file is already in
// the playlist folder (from an earlier or interrupted run), numbered or not
// (findSavedFiles); returns the rest.
async function leaveOutSavedSongs (job, songs, folder) {
  if (!job.skipExisting) return songs
  const savedFiles = await findSavedFiles(songs, folder)

  return songs.filter((song) => {
    if (!savedFiles.has(song.number)) return true

    job.skippedCount++
    job.done++
    addEvent(job, `↷ ${fileBaseFor(song)} — already in the folder`)
    noteOutcome(job, song, { outcome: 'skipped' })
    return false
  })
}

// Work through the prepared songs ({ number, row, title, artist, album, year,
// genre, durationSec, video? }) and leave the job ready (a ZIP to fetch),
// saved (in its folder) or failed.
async function runJob (job, allSongs, userQuality) {
  // where finished songs go: the ZIP's source folder, or the chosen folder
  const songsFolder = job.outputFolder || job.tempFolder
  // looking through the drive takes a while, so it starts at once
  job.library = startLibraryIndex(job)

  // wait for the yt-dlp update check before touching the binary
  await ytDlpReady

  const songs = await leaveOutSavedSongs(job, leaveOutSongsListedTwice(job, allSongs), songsFolder)
  if (!(await hasRoomFor(job, songs.length, songsFolder))) return

  job.startedAt = Date.now()
  job.firstBatch = Math.min(job.parallel, songs.length)
  startHistory(job)
  await runWithLimit(
    {
      count: songs.length,
      parallel: () => job.parallel, // read before each song, as it can change mid-run
      isPaused: () => job.control === 'pause',
      shouldStop: () => job.control === 'stop'
    },
    (i) => processSong(job, songs[i], { userQuality, songsFolder })
  )
  keepStoppedPicks(job, songs)

  // a row skipped for repeating another row's song puts nothing in the folder
  const isAnySongThere = job.savedCount > 0 || job.skippedCount > job.listedTwiceCount
  if (!isAnySongThere) {
    failJob(job, emptyRunMessage(job))
    return
  }

  // before the songs are listed, as numbering renames some of them
  if (job.outputFolder && isCsvRun(job)) await finishPlaylistFolder(job, allSongs)
  const mp3s = resultFilesOf(job, songsFolder)
  const zipBytes = sizeOfFiles(songsFolder, mp3s)

  if (job.outputFolder) {
    await finishSavedJob(job, mp3s, zipBytes)
    return
  }
  await finishZipJob(job, mp3s, zipBytes)
}

// the folder the person chose: a playlist folder's parent, or the picked
// folder itself
function chosenFolderOf (job) {
  return job.isExactFolder ? job.outputFolder : path.dirname(job.outputFolder)
}

// Bail out before downloading for minutes and then running out of room for
// the ZIP, or on the drive. Fails the job (and returns false) when there
// isn't room for the songs.
async function hasRoomFor (job, trackCount, songsFolder) {
  const needed = estimateBytesNeeded(trackCount, { toFolder: Boolean(job.outputFolder) })
  const freeBefore = await freeSpace(songsFolder)
  if (freeBefore >= needed) return true

  const where = job.outputFolder ? ` on ${chosenFolderOf(job)}` : ''
  failJob(
    job,
    `Not enough disk space${where}. ${trackCount} tracks need about ` +
      `${formatBytes(needed)} free, but only ${formatBytes(freeBefore)} ` +
      'is available. Free up space, pick a lower quality, or split the ' +
      'CSV into smaller batches.'
  )
  return false
}

// The MP3s this run is about: in its playlist folder, every song there
// (saved now or by an earlier run); in a picked folder (which may hold other
// music) and in a ZIP, only the songs it saved under their own names, never
// a work file (track_3.mp3) that a failed or stopped song left behind
function resultFilesOf (job, songsFolder) {
  if (!job.outputFolder || job.isExactFolder) return job.savedFiles
  return listSongFiles(songsFolder)
}

// The files' total size; one that has gone missing counts as nothing
function sizeOfFiles (folder, names) {
  return names.reduce((sum, name) => {
    try {
      return sum + fs.statSync(path.join(folder, name)).size
    } catch (err) {
      console.log(`Could not read the size of ${name}:`, err.message)
      return sum
    }
  }, 0)
}

// ZIP mode is done once the MP3s are waiting for the browser to fetch them
async function finishZipJob (job, mp3s, zipBytes) {
  // Re-check with the real sizes now that the MP3s exist: the ZIP the browser
  // saves is about the size of the audio inside it.
  const neededNow = zipBytes * (PEAK_COPIES - 1)
  const freeNow = await freeSpace('.')

  if (freeNow < neededNow) {
    failJob(
      job,
      `Downloaded ${mp3s.length} tracks (${formatBytes(zipBytes)}), but ` +
        `saving the ZIP needs ${formatBytes(neededNow)} free and only ` +
        `${formatBytes(freeNow)} is available. Free up some disk space and ` +
        'try again.'
    )
    return
  }

  job.mp3s = mp3s
  job.zipBytes = zipBytes
  endRun(job, 'ready')
  job.expiry = setTimeout(() => {
    console.log(`Job ${job.id} was never downloaded, cleaning up`)
    removeJob(job).catch(() => {})
  }, JOB_TTL_MS)
  job.expiry.unref() // a ZIP nobody fetched shouldn't keep the process alive

  console.log(
    `Ready: ${mp3s.length} of ${job.total} tracks, ${formatBytes(zipBytes)}` +
      (job.failures.length ? ` (${job.failures.length} failed)` : '') +
      (job.reviews.length ? ` (${job.reviews.length} to review)` : '')
  )
}

// Copy one song in from another playlist folder (when reusing songs and one
// has it), or search (unless the song comes with its video), download, tag
// and save it, keeping the tracker up to date. Never throws: a failure becomes a ✗
// line, and a song with no sure match goes to the review list instead of
// being downloaded. A song cut short by Stop isn't counted as done.
async function processSong (job, song, { userQuality, songsFolder }) {
  const { number, row, title, artist } = song
  let isStopped = false
  let isWorkedOn = false // searched for or downloaded, so it sets the pace
  let ranked = [] // the search results, best first
  let video = null

  try {
    if (!title || !artist) {
      console.log('Skipping row (no title/artist):', row)
      noteFailure(job, NO_TITLE_OR_ARTIST)
      noteOutcome(job, song, { outcome: 'failed', reason: NO_TITLE_OR_ARTIST })
      return
    }

    setActive(job, number, {
      number,
      title,
      artist,
      phase: 'searching',
      downloadedBytes: 0,
      totalBytes: null,
      speedBps: null,
      startedAt: Date.now() // for how long the song took, once it ends
    })

    // already saved in another playlist folder: copied in, no YouTube at all
    if (await reuseFromLibrary(job, song, songsFolder)) return
    isWorkedOn = true
    if (!song.video && job.control !== 'stop') ranked = await searchRanked(song)
    if (job.control === 'stop') {
      isStopped = true
      return
    }

    video = song.video || chooseVideo(job, song, ranked)
    if (!video) return

    await downloadAndSave(job, song, video, { userQuality, songsFolder })
  } catch (err) {
    if (job.control === 'stop') {
      isStopped = true // yt-dlp was killed by Stop, not a real failure
      return
    }
    noteSongFailure(job, song, err, { video, ranked })
  } finally {
    const startedAt = isWorkedOn ? job.active[number]?.startedAt : null
    clearActive(job, number)
    if (!isStopped) noteDone(job, { startedAt })
  }
}

// Search results scored against the wanted song, best first. matching.js
// labels by score alone, so a live take or an overlong video can still read
// "Good match"; the review list ticks Good matches by default, so only a
// result safe to download unasked keeps that label.
function rankAndLabel (videos, wanted) {
  return rankCandidates(videos, wanted).map((video) =>
    video.label === 'Good match' && !isConfidentMatch(video) ? { ...video, label: 'Possible' } : video
  )
}

// YouTube's results for a song, scored against it, best match first
async function searchRanked ({ title, artist, durationSec }) {
  const query = `${title} ${artist}`
  console.log('Searching:', query)
  const videos = await services.searchVideos(query)
  return rankAndLabel(videos, { title, artist, durationSec })
}

// The search result to download, or null when there's none we can be sure
// of: such a song goes to the review list with what the search found, so the
// person picks the version instead of getting a live take, a cover or a
// different song. A live take or a long video can outscore the right upload,
// so every result is checked, not just the first.
function chooseVideo (job, song, ranked) {
  const query = `${song.title} ${song.artist}`

  if (!ranked.length) {
    console.log('No video found for:', query)
    noteReview(job, song, { ...NOT_FOUND, candidates: [] })
    return null
  }
  const match = ranked.find(isConfidentMatch)
  if (!match) {
    console.log(`No exact match for "${query}", the closest was "${ranked[0].title}"`)
    noteReview(job, song, { ...NO_EXACT_MATCH, candidates: ranked })
    return null
  }
  return match
}

// Download one song's audio, tag it and move it into place under its title
async function downloadAndSave (job, song, video, { userQuality, songsFolder }) {
  const { number, title, artist, album, year, genre } = song
  const { tempFolder } = job

  // file name from the title (and the artist, when another song shares the
  // title), with spaces (no underscores), and its number first in a
  // car-ready folder
  const fileBase = saveNameFor(job, song)

  // Download to a predictable ASCII name so we always know where the file
  // landed (yt-dlp sanitizes its own output names), then rename to the
  // pretty title once it's tagged.
  const workBase = `track_${number}`
  // yt-dlp runs inside the work folder (cwd below), so the template carries no
  // path: in a path, "%" would start a field and "$NAME" would be expanded
  const outputTemplate = `${workBase}.%(ext)s`
  const mp3Path = `${tempFolder}/${workBase}.mp3`

  // 1) download pure audio (tried again after a throttle or a dropped connection)
  await downloadWithRetries(job, number, () =>
    services.downloadMP3(video.url, outputTemplate, userQuality, {
      signal: job.abort.signal,
      cookiesBrowser: job.cookiesBrowser,
      cwd: tempFolder,
      onProgress: (update) => updateActive(job, number, update)
    })
  )
  if (!fs.existsSync(mp3Path)) throw new Error('no MP3 produced')

  // 2) fetch nice square album art (movie/album style)
  updateActive(job, number, { phase: 'tagging' })
  const coverPath = await services.fetchAlbumArt(
    { title, artist, album, video },
    tempFolder,
    workBase
  )

  // 3) apply metadata from CSV + embed cover
  try {
    const track = song.track ? `${song.track.number}/${song.track.total}` : ''
    await applyMetadataAndCover(mp3Path, coverPath, { title, artist, album, year, genre, track })
  } catch (tagErr) {
    console.log('Tagging / cover error (keeping audio anyway):', tagErr)
  }

  const finalPath = await renameToUniqueTitle(mp3Path, songsFolder, fileBase, job.reservedNames)
  await noteSaved(job, song, finalPath)
  console.log('Tagged & Downloaded:', finalPath)
}

// The download itself. With "auto-retry", a failure that looks temporary
// (YouTube throttling, a dropped connection) is tried again twice, after a
// wait the page counts down; Stop ends the wait. Without it, one try.
function downloadWithRetries (job, number, download) {
  return withRetries(
    () => {
      updateActive(job, number, { phase: 'downloading', retryAt: null })
      return download()
    },
    {
      attempts: job.options.autoRetry ? DEFAULT_ATTEMPTS : 1,
      delaysMs: services.retryDelaysMs,
      signal: job.abort.signal,
      onRetry: ({ attempt, delayMs }) => {
        console.log(`Trying song ${number} again (try ${attempt}) in ${delayMs} ms`)
        updateActive(job, number, {
          phase: 'retrying',
          attempt, // the try that comes after the wait: 2 or 3
          retryAt: Date.now() + delayMs,
          speedBps: null
        })
      }
    }
  )
}

// A song that went wrong gets a ✗ line. When its download failed, it also
// goes to the review list with the search's other results, since another
// upload of the same song often downloads fine; anything else (its search
// broke) ends the song as failed.
function noteSongFailure (job, song, err, { video, ranked }) {
  console.log('Error downloading:', err.stderr || err.message || err)
  noteFailure(job, describeSongFailure(song, err))
  if (!video) {
    noteOutcome(job, song, { outcome: 'failed', reason: shortErrorReason(err) })
    return
  }

  // The failed video comes first: it was the match, and a download blocked by
  // throttling or YouTube's bot check works again later or with YouTube
  // sign-in. The other results follow, in case it's gone for good.
  const failed = song.video ? pickedCandidate(song) : video
  noteReview(job, song, {
    reason: DOWNLOAD_FAILED + shortErrorReason(err),
    candidates: [failed, ...ranked.filter((candidate) => candidate.videoId !== video.videoId)]
  })
}

// a picked song's own video, offered again on the review list
function pickedCandidate (song) {
  return { ...song.video, score: 1, label: 'Good match', variant: [] }
}

// Stop on a "Download selected" run: every picked song that wasn't saved and
// isn't listed yet (cut short, or never started) goes back on the review list
// with its picked version, so the choice isn't lost
function keepStoppedPicks (job, songs) {
  if (job.control !== 'stop') return
  const listed = new Set(job.reviews.map((item) => item.number))
  const saved = new Set(job.savedNumbers)

  for (const song of songs) {
    if (!song.video || listed.has(song.number) || saved.has(song.number)) continue
    listForReview(job, song, { reason: STOPPED_PICK, candidates: [pickedCandidate(song)] })
  }
}

// A failed "Download selected" run (no room on the drive, the drive gone, an
// unexpected error) mustn't lose the picks either: each one it didn't deliver
// and hasn't listed goes back on the review list with its picked version. A
// folder run keeps the songs it saved; a failed ZIP run delivers none.
function keepUndeliveredPicks (job) {
  const listed = new Set(job.reviews.map((item) => item.number))
  const delivered = new Set(job.outputFolder ? job.savedNumbers : [])

  for (const song of job.picks) {
    if (listed.has(song.number) || delivered.has(song.number)) continue
    listForReview(job, song, { reason: FAILED_RUN_PICK, candidates: [pickedCandidate(song)] })
  }
}

// --- reusing songs from other playlists, and the car-ready playlist folder ---

// How far below the chosen folder songs to reuse are looked for: its
// playlist folders, and one level more
const LIBRARY_DEPTH = 2

// a run of a whole CSV, rather than of songs picked on the review list
function isCsvRun (job) {
  return job.picks.length === 0
}

// "Reuse songs across playlists": index the songs in the chosen folder's
// other playlist folders (not this one's own) in the background, for each
// song to look in before searching YouTube. null when the run doesn't reuse
// songs. Never rejects: a scan that breaks is logged, and songs download as
// usual.
function startLibraryIndex (job) {
  if (!job.options.reuseSongs) return null
  return buildLibraryIndex(chosenFolderOf(job), {
    excludeFolder: job.outputFolder,
    maxDepth: LIBRARY_DEPTH
  }).catch((err) => {
    console.log('Could not look for songs to reuse:', err.message)
    return null
  })
}

// Copy the song in from another playlist folder when the library surely has
// it, under the name a download would get. True when it was; a failed copy is
// logged and the song is downloaded as usual.
async function reuseFromLibrary (job, song, songsFolder) {
  if (!job.library) return false
  const hit = findInLibrary(await job.library, song)
  if (!hit || job.control === 'stop') return false

  const target = claimUniqueName(songsFolder, saveNameFor(job, song), job.reservedNames)
  try {
    await copyIntoPlaylist(hit.path, target)
  } catch (err) {
    releaseName(job.reservedNames, target) // the download may take the name after all
    console.log(`Could not copy ${hit.path} (downloading the song instead):`, err.message)
    return false
  }
  await noteReused(job, song, target, path.basename(path.dirname(hit.path)))
  console.log('Reused:', hit.path, '->', target)
  return true
}

// A CSV run into its playlist folder is over (saved, or stopped after saving
// some): number the songs saved earlier without one, then write the playlist
// file. Neither may fail the run: the songs are in the folder either way.
async function finishPlaylistFolder (job, allSongs) {
  const songs = allSongs.filter((song) => song.title && song.artist && song.sameSongAs == null)
  try {
    if (job.options.numberTracks) await numberUnnumberedSongs(job.outputFolder, songs)
    if (job.options.writePlaylist) await writePlaylistFile(job, songs)
  } catch (err) {
    console.log('Could not finish the playlist folder:', err.message)
  }
}

// Car-ready: this CSV's songs that sit in the folder without their number
// (saved by a run without numbers, picked later, or saved by an earlier
// version under a title another song shares) get it, so the whole folder
// sorts in the CSV's order. A song already in its numbered file is left be.
async function numberUnnumberedSongs (folder, songs) {
  const savedFiles = await findSavedFiles(songs, folder)
  for (const song of songs) {
    const fileName = savedFiles.get(song.number)
    if (!fileName || isNumberedFile(song, fileName)) continue
    const [numbered] = savedNamesOf(song)
    await renameUnlessTaken(folder, fileName, path.join(folder, numbered))
  }
}

// The song's file has its number already: its own numbered name, or the one
// an earlier version gave it by its title alone
function isNumberedFile (song, fileName) {
  const [numbered] = savedNamesOf(song)
  const titleOnly = numberedFileName(song.track.number, song.track.total, titleBaseOf(song))
  return [numbered, titleOnly].some((name) => nameKey(name) === nameKey(fileName))
}

// Rename the file listed as `fileName` in `folder`, but never over a file
// that's already there (that song keeps its plain name). Problems are
// logged: one song's name isn't worth a failed run.
async function renameUnlessTaken (folder, fileName, to) {
  try {
    if (await pathExists(to)) {
      console.log(`Not numbering ${fileName}: ${path.basename(to)} is already there`)
      return
    }
    await onListedFile(folder, fileName, (from) => fs.promises.rename(from, to))
  } catch (err) {
    console.log(`Could not number ${fileName}:`, err.message)
  }
}

async function pathExists (filePath) {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

// Car-ready: "<playlist>.m3u" beside the songs, listing every song of this
// CSV whose file is in the folder, in the CSV's order (songs finish in any
// order). A picks run leaves it alone; running the CSV again rewrites it.
async function writePlaylistFile (job, songs) {
  const files = songFilesByKey(job.outputFolder)
  const entries = playlistEntries(job, songs, files, await findSavedFiles(songs, job.outputFolder))
  if (!entries.length) return
  job.playlistFile = await writeM3u(job.outputFolder, job.name, entries)
}

// Each song's file: the name this run saved it under (" (2)" when the name
// was taken), or else the file it was found in (savedFiles, from
// findSavedFiles). No file is listed twice. Names are written composed
// (NFC), as the drive stores them: macOS lists an accented name on a FAT32
// or exFAT drive decomposed, which a car stereo reading the playlist
// wouldn't find.
function playlistEntries (job, songs, files, savedFiles) {
  const listed = new Set()
  return songs.flatMap((song) => {
    const savedNow = job.savedFileOf[song.number]
    const fileName = [savedNow && files.get(nameKey(savedNow)), savedFiles.get(song.number)].find(
      (name) => name && !listed.has(nameKey(name))
    )
    if (!fileName) return []
    listed.add(nameKey(fileName))
    const { title, artist, durationSec } = song
    return [{ fileName: fileName.normalize('NFC'), title, artist, durationSec }]
  })
}

// Folder mode is done once the songs are in place: there's no ZIP to hand over
async function finishSavedJob (job, mp3s, bytes) {
  await fs.promises.rm(job.tempFolder, { recursive: true, force: true })
  // the songs are saved either way, so a leftover ._ file isn't worth failing over
  await removeMacLeftovers(job).catch((err) =>
    console.log('Could not remove macOS ._ files:', err.message)
  )
  job.mp3s = mp3s
  job.zipBytes = bytes
  endRun(job, 'saved')
  releaseFolder(job) // tidied up above
  keepRecord(job)

  console.log(
    `Saved ${mp3s.length} of ${job.total} tracks (${formatBytes(bytes)}) ` +
      `to ${job.outputFolder}`
  )
}

// Stream the ZIP as a normal browser download. Nothing is buffered on either
// side: archiver reads the MP3s and the browser writes straight to disk.
app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id)

  if (!job || job.status !== 'ready') {
    return res
      .status(404)
      .send('This download is no longer available. Run the CSV again.')
  }

  // a second click while the first download is running would fight over the
  // same files, so hand the job to this response only
  jobs.delete(job.id)
  clearTimeout(job.expiry)

  res.setHeader('Content-Type', 'application/zip')
  // "<playlist>.zip"; the plain name is the fallback for old browsers
  const zipName = `${job.name}.zip`
  const plainName = zipName.replace(/[^\x20-\x7e]|"/g, '_')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${plainName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`
  )

  // store, don't deflate: MP3s are already compressed, so deflating 100s of MB
  // of audio burns CPU for about nothing
  const zip = archiver('zip', { store: true })
  zip.on('error', (err) => console.log('ZIP error:', err))
  zip.pipe(res)

  // add the MP3s by name so a leftover cover JPG can't sneak into the ZIP
  for (const name of job.mp3s) {
    zip.file(path.join(job.tempFolder, name), { name })
  }

  // only remove the temp files once the ZIP has actually been streamed out
  res.on('close', () => {
    if (res.writableFinished) {
      console.log(`ZIP sent (${formatBytes(job.zipBytes)})`)
    } else {
      console.log('Browser disconnected before the ZIP finished')
    }
    fs.promises
      .rm(job.tempFolder, { recursive: true, force: true })
      .catch(() => {})
  })

  zip.finalize()
})

if (require.main === module) {
  const port = process.env.PORT || 3000
  // Only this computer: the server can write into any folder you can, so it
  // shouldn't take requests from the rest of the network. Setting ZIPIFY_HOST
  // to this computer's network address opts in (onlyThisComputer then
  // accepts that one name besides localhost).
  const listenOn = process.env.ZIPIFY_HOST ? '0.0.0.0' : '127.0.0.1'
  app.listen(port, listenOn, () => console.log(`Server running at http://localhost:${port}`))
}

module.exports = {
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
  isLeftoverWorkFolder,
  fetchAlbumArt,
  itunesResultMatches,
  // now in matching.js, still exported from here for older callers
  splitArtists,
  looseText
}
