// Live progress for a running job: what yt-dlp reports while downloading a
// song, the estimates the page shows (total size, time left), and the
// history its charts are drawn from.

// yt-dlp prints one line per update in this shape, with "NA" for anything it
// doesn't know yet, e.g. "ZTPROG 7168 2168484 NA 84560.15 downloading"; the
// last word becomes "finished" once the download is complete
const PROGRESS_PREFIX = 'ZTPROG'
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX} %(progress.downloaded_bytes)s ` +
  '%(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s ' +
  '%(progress.status)s'

function toNumber (value) {
  const n = Number(value)
  return value !== undefined && value !== 'NA' && Number.isFinite(n) ? n : null
}

// "ZTPROG 7168 2168484 NA 84560.15 downloading"
//   -> { downloadedBytes, totalBytes, speedBps, isFinished }
// Anything else yt-dlp prints -> null.
function parseProgressLine (line) {
  const [prefix, downloaded, total, estimate, speed, status] = String(line)
    .trim()
    .split(/\s+/)
  if (prefix !== PROGRESS_PREFIX) return null

  return {
    downloadedBytes: toNumber(downloaded) ?? 0,
    totalBytes: toNumber(total) ?? toNumber(estimate),
    speedBps: toNumber(speed),
    isFinished: status === 'finished'
  }
}

// What one line of yt-dlp output means for the song being worked on:
// { phase, ...sizes } to merge into the tracker, or null for anything else.
// A finished download reads as "converting", because that's what yt-dlp
// does next, and it can take a while on a slow pen drive. (Only yt-dlp's own
// "finished" counts: an estimated size can be reached before the real end.)
function progressUpdateFromLine (line) {
  const progress = parseProgressLine(line)
  if (progress) {
    const { isFinished, ...sizes } = progress
    return { phase: isFinished ? 'converting' : 'downloading', ...sizes }
  }
  if (String(line).startsWith('[ExtractAudio]')) return { phase: 'converting' }
  return null
}

// Sizes as people read them, matching the page: "512 KB", "3.7 MB", "15 MB"
function formatBytes (bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB'
  if (bytes >= 10 * 1024 ** 2) return Math.round(bytes / 1024 ** 2) + ' MB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

// How much of the pause going on now counts against the run's time: from
// when it began, or from when downloads began if it began before them (Pause
// works while the run is still getting ready). 0 when the run isn't paused,
// and before its downloads begin.
function currentPauseMs ({ startedAt, pausedAt }, now) {
  if (startedAt == null || pausedAt == null) return 0
  return Math.max(0, now - Math.max(startedAt, pausedAt))
}

// How long the run has actually been working: time since downloads began,
// minus earlier pauses (pausedMs) and the current one (currentPauseMs).
// Never negative.
function activeElapsedMs (run, now) {
  if (run.startedAt == null) return 0
  return Math.max(0, now - run.startedAt - run.pausedMs - currentPauseMs(run, now))
}

// Time left: the average time per finished song so far, times the songs
// still to go. Unknown (null) until a song has finished.
function estimateRemainingMs ({ elapsedMs, done, total }) {
  if (!done) return null
  return Math.round((elapsedMs / done) * (total - done))
}

// Time left comes from how long a song takes, not from how often songs
// finish. A song holds one of the "Download at once" slots from when it's
// started on until it's saved (searching, downloading, converting, tagging),
// and the slots work side by side, so the songs left take about
//   (time a song takes) x (songs left) / (songs at once)
// (Little's law). Unlike the gaps between finished songs, that holds still
// when songs finish in bunches, or several finish during a pause (a song
// keeps going while paused), and it follows a new "Download at once" the
// moment it's set.

// The time a song takes is read from the songs that finished in the last 5
// minutes of the run's active time...
const PACE_WINDOW_MS = 5 * 60 * 1000
// ...or from the last 20 when fewer finished in that time
const MIN_PACE_SONGS = 20

function average (values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// The time a song takes now: the average of the recent songs (see above),
// plus how far the songs still running have gone past that average, shared
// out among them. The second part keeps counting while no song finishes, so
// a stall raises the estimate a little every second instead of all at once
// when the late song finally finishes.
function msPerSong (songTimes, activeAges, elapsedMs) {
  const inWindow = songTimes.filter((song) => song.at > elapsedMs - PACE_WINDOW_MS)
  const recent = inWindow.length >= MIN_PACE_SONGS ? inWindow : songTimes.slice(-MIN_PACE_SONGS)
  const averageMs = average(recent.map((song) => song.tookMs))
  const overdueMs = activeAges.reduce((sum, ageMs) => sum + Math.max(0, ageMs - averageMs), 0)
  return averageMs + overdueMs / recent.length
}

// Time left, which the page counts down.
// - songTimes: [{ at, tookMs }] for each song worked on (searched for or
//   downloaded), in the order they finished: when it finished on the run's
//   active clock, and how long it took (wall clock, from start to saved).
//   Songs skipped as already saved, copied in from another playlist or with
//   nothing to search for count as done but took no download time, so they
//   aren't in it: they shorten the time left, not the time a song takes.
// - activeAges: how long each song being worked on now has been going.
// - parallel: "Download at once" right now; firstBatch: how many songs
//   started together when the downloads began (that limit, or fewer songs).
// Unknown (null) until the first batch is through: songs that started
// together finish close together, so the first few can't tell the time a
// song takes. 0 once no song is left. When the last songs are all under way,
// the run ends when the slowest of them does.
function estimateRemainingMsRecent ({
  songTimes,
  activeAges = [],
  done,
  total,
  elapsedMs,
  parallel = 1,
  firstBatch = 1
}) {
  const left = total - done
  if (left <= 0) return 0
  const worked = songTimes.length
  // a run with fewer songs left to work on than the first batch needn't wait for it
  if (!worked || worked < Math.min(firstBatch, worked + left)) return null

  const songMs = msPerSong(songTimes, activeAges, elapsedMs)
  if (left <= activeAges.length) {
    return Math.round(Math.max(...activeAges.map((ageMs) => Math.max(0, songMs - ageMs))))
  }
  return Math.round((songMs * left) / Math.max(1, Math.min(parallel, left)))
}

// Size of the whole run: what's saved so far plus the average saved song for
// each one still to go. Unknown (null) until a song has been saved.
function estimateTotalBytes ({ savedBytes, savedCount, done, total }) {
  if (!savedCount) return null
  return Math.round(savedBytes + (savedBytes / savedCount) * (total - done))
}

// The history with one more point at the end, as a new array. It keeps at
// most maxPoints: when full, every other point goes (the first one stays), so
// a long run keeps its whole shape at half the detail rather than forgetting
// how it started.
function addHistoryPoint (history, point, maxPoints) {
  const kept = history.length >= maxPoints ? history.filter((_, i) => i % 2 === 0) : history
  return [...kept, point]
}

// At most maxPoints of the points, spread evenly from the first to the
// latest: all a chart needs, however long the run
function thinEvenly (points, maxPoints) {
  if (points.length <= maxPoints) return points
  if (maxPoints < 2) return points.slice(points.length - maxPoints)
  const step = (points.length - 1) / (maxPoints - 1)
  return Array.from({ length: maxPoints }, (_, i) => points[Math.round(i * step)])
}

// How far back the speed on the page's chart looks: long enough for songs
// saved a few at a time to read as a steady speed, short enough to follow a
// slowdown
const SPEED_WINDOW_MS = 30_000

// What had been saved by active time t, read off the history's points
// ({ t, savedBytes }, ascending t) along a straight line between the two
// either side of it. Nothing is saved before the run starts (t = 0).
function savedBytesAt (points, t) {
  const after = points.findIndex((point) => point.t >= t)
  if (after === -1) return points.at(-1)?.savedBytes ?? 0
  const before = after === 0 ? { t: 0, savedBytes: 0 } : points[after - 1]
  const point = points[after]
  const span = point.t - before.t
  if (span <= 0) return point.savedBytes
  return before.savedBytes + ((point.savedBytes - before.savedBytes) * (t - before.t)) / span
}

// The download speed the page's chart shows, in bytes a second: what was
// saved over the last 30 s of the run's active time (time paused doesn't
// count), so it reads steady while songs keep being saved and falls to 0
// within 30 s once none is. (yt-dlp's own speed only covers the second or so
// a song spends downloading, between searching, converting and tagging, so
// the songs downloading at any moment added up to 0 most of the time.)
// `history` is the points so far ({ t, savedBytes }, ascending t, on the
// run's active clock) and `latest` the point being added. 0 until something
// is saved; never negative.
function throughputBps (history, latest) {
  const from = Math.max(0, latest.t - SPEED_WINDOW_MS)
  const seconds = (latest.t - from) / 1000
  if (!latest.savedBytes || seconds <= 0) return 0
  const savedSince = latest.savedBytes - savedBytesAt(history, from)
  return Math.max(0, Math.round(savedSince / seconds))
}

module.exports = {
  PROGRESS_TEMPLATE,
  parseProgressLine,
  progressUpdateFromLine,
  formatBytes,
  activeElapsedMs,
  currentPauseMs,
  estimateRemainingMs,
  estimateRemainingMsRecent,
  estimateTotalBytes,
  addHistoryPoint,
  thinEvenly,
  throughputBps
}
