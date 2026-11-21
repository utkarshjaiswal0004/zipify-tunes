const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  parseProgressLine,
  progressUpdateFromLine,
  estimateRemainingMs,
  estimateRemainingMsRecent,
  estimateTotalBytes,
  activeElapsedMs,
  currentPauseMs,
  formatBytes,
  addHistoryPoint,
  thinEvenly,
  throughputBps
} = require('../progress')

const MB = 1024 * 1024

// --- reading yt-dlp's progress lines (format captured from a real run) ---

test('reads bytes, total and speed from a yt-dlp progress line', () => {
  const progress = parseProgressLine('ZTPROG 7168 2168484 NA 84560.1546704618 downloading')

  assert.deepEqual(progress, {
    downloadedBytes: 7168,
    totalBytes: 2168484,
    speedBps: 84560.1546704618,
    isFinished: false
  })
})

test('falls back to the estimated total when the exact size is unknown', () => {
  const progress = parseProgressLine('ZTPROG 1024 NA 3000000 NA')

  assert.equal(progress.totalBytes, 3000000)
  assert.equal(progress.speedBps, null)
})

test('ignores every other line yt-dlp prints', () => {
  assert.equal(parseProgressLine('[download] Destination: track_1.webm'), null)
  assert.equal(parseProgressLine(''), null)
})

// --- estimates shown on the page ---

test('time left is the average time per song so far, times the songs left', () => {
  const etaMs = estimateRemainingMs({ elapsedMs: 60_000, done: 2, total: 10 })

  assert.equal(etaMs, 240_000)
})

test('time left is unknown until a song has finished', () => {
  assert.equal(estimateRemainingMs({ elapsedMs: 5_000, done: 0, total: 10 }), null)
})

test('total size is what is saved plus the average song for each one left', () => {
  // 2 songs saved (8 MB), 1 failed, 7 still to go
  const totalBytes = estimateTotalBytes({
    savedBytes: 8 * MB,
    savedCount: 2,
    done: 3,
    total: 10
  })

  assert.equal(totalBytes, 8 * MB + 4 * MB * 7)
})

test('total size is unknown until a song has been saved', () => {
  const totalBytes = estimateTotalBytes({ savedBytes: 0, savedCount: 0, done: 1, total: 10 })

  assert.equal(totalBytes, null)
})

// --- turning yt-dlp output into tracker updates ---

test('a partly downloaded song is shown as downloading, with its sizes', () => {
  const update = progressUpdateFromLine('ZTPROG 1048576 2168484 NA 524288 downloading')

  assert.equal(update.phase, 'downloading')
  assert.equal(update.downloadedBytes, 1048576)
})

test('a fully downloaded song is shown as converting, not stuck at 100%', () => {
  const update = progressUpdateFromLine('ZTPROG 2168484 2168484 NA NA finished')

  assert.equal(update.phase, 'converting')
})

test("yt-dlp's ExtractAudio line means the song is being converted", () => {
  const update = progressUpdateFromLine('[ExtractAudio] Destination: track_1.mp3')

  assert.deepEqual(update, { phase: 'converting' })
})

test('other yt-dlp lines change nothing', () => {
  assert.equal(progressUpdateFromLine('[youtube] LrM_Y39Gmhk: Downloading webpage'), null)
})

// --- sizes as people read them (same rules as the page) ---

test('sizes read naturally from KB up to GB', () => {
  assert.equal(formatBytes(512 * 1024), '512 KB')
  assert.equal(formatBytes(3869217), '3.7 MB')
  assert.equal(formatBytes(15 * MB), '15 MB')
  assert.equal(formatBytes(10.5 * 1024 * MB), '10.5 GB')
})

test('reaching an estimated size is not the same as finishing', () => {
  // only an estimate is known, and the real file turned out bigger
  const update = progressUpdateFromLine('ZTPROG 3000000 NA 3000000 1000 downloading')

  assert.equal(update.phase, 'downloading')
})

test('time spent paused does not count toward the elapsed time', () => {
  // started at 0 s; 10 s of earlier pauses; paused again since 50 s; now 60 s
  const elapsed = activeElapsedMs({ startedAt: 0, pausedMs: 10_000, pausedAt: 50_000 }, 60_000)

  assert.equal(elapsed, 40_000)
})

test('elapsed time is zero before downloads start', () => {
  assert.equal(activeElapsedMs({ startedAt: null, pausedMs: 0, pausedAt: null }, 60_000), 0)
})

test('a pause from before downloads began only counts from when they did, so "so far" is never negative', () => {
  // Pause at 2 s, while the run was still getting ready; downloads began at 12 s
  const paused = { startedAt: 12_000, pausedMs: 0, pausedAt: 2_000 }

  assert.equal(activeElapsedMs(paused, 15_000), 0)

  // Resume at 20 s: the 8 s paused since downloads began are left out
  const resumed = { ...paused, pausedMs: currentPauseMs(paused, 20_000), pausedAt: null }
  assert.equal(resumed.pausedMs, 8_000)
  assert.equal(activeElapsedMs(resumed, 80_000), 60_000)
})

test('a pause that ended before downloads began does not count at all', () => {
  // Pause at 2 s, Resume at 5 s, downloads began at 12 s
  const pausedMs = currentPauseMs({ startedAt: null, pausedAt: 2_000 }, 5_000)

  assert.equal(pausedMs, 0)
  assert.equal(activeElapsedMs({ startedAt: 12_000, pausedMs, pausedAt: null }, 15_000), 3_000)
})

// --- time left from how long each song takes (the page counts it down) ---

// how long a song takes in these runs, from its search to its saved file
const SONG_MS = 21_000

// `count` songs the server has noted as worked on: when each one finished on
// the run's active clock (`at`, the first at `fromMs`, then `gapMs` apart) and
// how long it took (`tookMs`)
function songsTaking (tookMs, count, { fromMs = tookMs, gapMs = tookMs } = {}) {
  return Array.from({ length: count }, (_, i) => ({ at: fromMs + i * gapMs, tookMs }))
}

test("time left is a song's time, times the songs left, over the songs downloading at once", () => {
  // 6 at once, every song taking 21 s: one done every 3.5 s
  const etaMs = estimateRemainingMsRecent({
    songTimes: songsTaking(SONG_MS, 12, { gapMs: 3_500 }),
    activeAges: [1_000, 5_000, 9_000, 13_000, 17_000, 20_000],
    done: 12,
    total: 30,
    elapsedMs: 60_000,
    parallel: 6,
    firstBatch: 6
  })

  assert.equal(etaMs, (SONG_MS * 18) / 6)
})

test('songs finishing unevenly, 1 s then 6 s apart, take the time left down a step at a time, never up', () => {
  // 6 at once, every song taking 21 s, so a song every 3.5 s on average, but
  // finishing in pairs: 1 s apart, then 6 s
  const finishedAt = Array.from({ length: 40 }, (_, i) => SONG_MS + Math.floor(i / 2) * 7_000 + (i % 2) * 1_000)
  const etas = finishedAt.map((at, i) =>
    estimateRemainingMsRecent({
      songTimes: finishedAt.slice(0, i + 1).map((t) => ({ at: t, tookMs: SONG_MS })),
      activeAges: [],
      done: i + 1,
      total: 500,
      elapsedMs: at,
      parallel: 6,
      firstBatch: 6
    })
  )

  const known = etas.slice(5) // from the sixth song: the first six at once are through
  const steps = known.slice(1).map((eta, i) => known[i] - eta)
  assert.deepEqual(new Set(steps), new Set([SONG_MS / 6]), "one song's share less at each song")
})

test('one song a minute late raises the time left by far less than a third', () => {
  const steady = songsTaking(SONG_MS, 40, { gapMs: 3_500 })
  const run = { done: 40, total: 500, elapsedMs: 157_500, parallel: 6, firstBatch: 6 }
  const late = SONG_MS + 60_000

  const onTime = estimateRemainingMsRecent({ ...run, songTimes: steady, activeAges: [] })
  const stillRunning = estimateRemainingMsRecent({ ...run, songTimes: steady, activeAges: [late] })
  const nextOnTime = estimateRemainingMsRecent({
    ...run,
    done: 41,
    songTimes: [...steady, { at: run.elapsedMs, tookMs: SONG_MS }],
    activeAges: []
  })
  const nextLate = estimateRemainingMsRecent({
    ...run,
    done: 41,
    songTimes: [...steady, { at: run.elapsedMs, tookMs: late }],
    activeAges: []
  })

  assert.ok(stillRunning > onTime, 'a song running late does slow the estimate')
  assert.ok(stillRunning < onTime * 1.3, `${stillRunning} ms against ${onTime} ms`)
  assert.ok(nextLate < nextOnTime * 1.3, `${nextLate} ms against ${nextOnTime} ms`)
})

test('songs running long past the usual time raise the time left, more the longer they run', () => {
  const run = { songTimes: songsTaking(SONG_MS, 40, { gapMs: 3_500 }), done: 40, total: 500, elapsedMs: 157_500, parallel: 6, firstBatch: 6 }
  const allRunningFor = (ageMs) => estimateRemainingMsRecent({ ...run, activeAges: Array(6).fill(ageMs) })

  assert.equal(allRunningFor(SONG_MS), allRunningFor(1_000), 'not late yet')
  assert.ok(allRunningFor(60_000) > allRunningFor(SONG_MS))
  assert.ok(allRunningFor(90_000) > allRunningFor(60_000))
})

test('with only the last songs left, all under way, time left is what the slowest has still to go', () => {
  const etaMs = estimateRemainingMsRecent({
    songTimes: songsTaking(SONG_MS, 20, { gapMs: 3_500 }),
    activeAges: [5_000, 12_000, 20_000],
    done: 47,
    total: 50,
    elapsedMs: 100_000,
    parallel: 6,
    firstBatch: 6
  })

  assert.equal(etaMs, SONG_MS - 5_000)
})

test('time left is unknown until the first songs at once are through, and skipped songs never count', () => {
  // 61 songs skipped as already saved, then 6 at once: the first five done
  const run = { activeAges: [], total: 500, elapsedMs: 25_000, parallel: 6, firstBatch: 6 }
  const firstSongs = songsTaking(SONG_MS, 6, { gapMs: 500 })

  const afterFive = estimateRemainingMsRecent({ ...run, songTimes: firstSongs.slice(0, 5), done: 61 + 5 })
  const afterSix = estimateRemainingMsRecent({ ...run, songTimes: firstSongs, done: 61 + 6 })

  assert.equal(afterFive, null, 'the first songs finish close together: no pace yet')
  assert.equal(afterSix, (SONG_MS * (500 - 67)) / 6, 'their time, not 67 quick songs')
})

test('a new "Download at once" changes the time left at once, and raising it never brings back "unknown"', () => {
  const run = { songTimes: songsTaking(SONG_MS, 6, { gapMs: 500 }), activeAges: [], done: 6, total: 100, elapsedMs: 25_000, firstBatch: 6 }
  const at = (parallel) => estimateRemainingMsRecent({ ...run, parallel })

  assert.equal(at(6), (SONG_MS * 94) / 6)
  assert.equal(at(2), at(6) * 3)
  assert.equal(at(12), at(6) / 2)
})

test('songs that finish while paused do not make the time left shrink', () => {
  // 20 songs done, 6 running; then Pause: no new song starts, and the 6
  // finish during it, all at the paused clock, having taken their usual time
  const PAUSED_AT = 88_000
  const before = estimateRemainingMsRecent({
    songTimes: songsTaking(SONG_MS, 20, { gapMs: 3_500 }),
    activeAges: [3_000, 6_000, 10_000, 13_000, 17_000, 20_000],
    done: 20,
    total: 100,
    elapsedMs: PAUSED_AT,
    parallel: 6,
    firstBatch: 6
  })
  const during = estimateRemainingMsRecent({
    songTimes: [...songsTaking(SONG_MS, 20, { gapMs: 3_500 }), ...songsTaking(SONG_MS, 6, { fromMs: PAUSED_AT, gapMs: 0 })],
    activeAges: [],
    done: 26,
    total: 100,
    elapsedMs: PAUSED_AT,
    parallel: 6,
    firstBatch: 6
  })

  assert.ok(during >= 0.9 * before * (74 / 80), `${during} ms, from ${before} ms with 80 left`)
})

test('when songs start taking a different time, the time left follows the last five minutes', () => {
  // thirty slow songs, a minute each, then five minutes of quick ones, 5 s each
  const slow = songsTaking(60_000, 30)
  const quick = songsTaking(5_000, 60, { fromMs: 1_805_000 })
  const run = { songTimes: [...slow, ...quick], activeAges: [], done: 90, total: 94, elapsedMs: 2_100_000, parallel: 1, firstBatch: 1 }

  assert.equal(estimateRemainingMsRecent(run), 20_000)
  assert.equal(estimateRemainingMs(run), 93_333, 'the overall average lags far behind')
})

test('with few songs in the last five minutes, the last 20 set the time a song takes', () => {
  // ten quick songs, then twenty taking two minutes each, one at a time
  const quick = songsTaking(5_000, 10)
  const slow = songsTaking(120_000, 20, { fromMs: 170_000 })

  const etaMs = estimateRemainingMsRecent({
    songTimes: [...quick, ...slow],
    activeAges: [],
    done: 30,
    total: 31,
    elapsedMs: 2_450_000,
    parallel: 1,
    firstBatch: 1
  })

  assert.equal(etaMs, 120_000)
})

test('time left is zero once no song is left', () => {
  const etaMs = estimateRemainingMsRecent({
    songTimes: songsTaking(SONG_MS, 3),
    activeAges: [],
    done: 3,
    total: 3,
    elapsedMs: 63_000,
    parallel: 3,
    firstBatch: 3
  })

  assert.equal(etaMs, 0)
})

test('time left is unknown while no song has been worked on, even with skipped songs done', () => {
  const run = { songTimes: [], activeAges: [], total: 500, elapsedMs: 2_000, parallel: 6, firstBatch: 6 }

  assert.equal(estimateRemainingMsRecent({ ...run, done: 0 }), null)
  assert.equal(estimateRemainingMsRecent({ ...run, done: 61 }), null)
})

// --- the history behind the page's charts ---

test('a history point goes at the end, leaving the old history as it was', () => {
  const before = [{ t: 0 }]

  const after = addHistoryPoint(before, { t: 2_000 }, 4)

  assert.deepEqual(after, [{ t: 0 }, { t: 2_000 }])
  assert.deepEqual(before, [{ t: 0 }])
})

test('a full history drops every other point to make room, keeping the first', () => {
  const full = [0, 2_000, 4_000, 6_000].map((t) => ({ t }))

  const history = addHistoryPoint(full, { t: 8_000 }, 4)

  assert.deepEqual(history.map((point) => point.t), [0, 4_000, 8_000])
})

test('a long history is thinned evenly, from the first point to the latest', () => {
  const points = Array.from({ length: 300 }, (_, i) => ({ t: i * 2_000 }))

  const thinned = thinEvenly(points, 120)
  const gaps = thinned.slice(1).map((point, i) => point.t - thinned[i].t)

  assert.equal(thinned.length, 120)
  assert.equal(thinned[0], points[0])
  assert.equal(thinned.at(-1), points.at(-1))
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 2_000, 'no gap much wider than another')
})

test('a short history is sent as it is', () => {
  const points = [{ t: 0 }, { t: 2_000 }]

  assert.deepEqual(thinEvenly(points, 120), points)
})

// --- the download speed on the chart: what was saved over the last 30 s ---

// The speed each point of a history would get, worked out as the run goes:
// from the points before it
function speedsOf (points) {
  return points.map((point, i) => throughputBps(points.slice(0, i), point))
}

// a history point every 2 s, from 0 s to `untilMs`, with savedBytesAt(t) saved by then
function sampledHistory (untilMs, savedBytesAt) {
  return Array.from({ length: untilMs / 2_000 + 1 }, (_, i) => ({
    t: i * 2_000,
    savedBytes: savedBytesAt(i * 2_000)
  }))
}

test('saving at a steady rate draws a flat speed line', () => {
  // 1 MB saved every second, for two minutes
  const history = sampledHistory(120_000, (t) => (t / 1_000) * MB)

  const speeds = speedsOf(history)

  assert.equal(speeds[0], 0, 'nothing saved yet')
  assert.deepEqual(new Set(speeds.slice(1)), new Set([MB]))
})

test('a burst of saving, then nothing, falls to 0 once 30 s have passed', () => {
  // 20 MB saved at 10 s, then nothing more
  const history = sampledHistory(60_000, (t) => (t >= 10_000 ? 20 * MB : 0))

  const speeds = speedsOf(history)
  const speedAt = (t) => speeds[t / 2_000]

  assert.equal(speedAt(8_000), 0, 'before anything is saved')
  assert.equal(speedAt(10_000), 2 * MB, 'what was saved, over the 10 s so far')
  assert.ok(speedAt(30_000) > 0 && speedAt(30_000) < speedAt(20_000), 'still in the last 30 s, spread thinner')
  assert.equal(speedAt(38_000), Math.round((20 * MB) / 30), 'over the last 30 s')
  assert.deepEqual(new Set(speeds.slice(40_000 / 2_000)), new Set([0]), 'from 40 s on')
})

test('time spent paused does not count toward the speed', () => {
  // 1 MB a second for 20 s, then a five-minute pause, then 2 s more of saving:
  // the history runs on the run's active clock, which stands still while paused
  const run = { startedAt: 0, pausedMs: 300_000, pausedAt: null }
  const history = sampledHistory(20_000, (t) => (t / 1_000) * MB)
  const afterPause = { t: activeElapsedMs(run, 322_000), savedBytes: 22 * MB }

  assert.equal(afterPause.t, 22_000)
  assert.equal(throughputBps(history, afterPause), MB)
})

test('the speed is never negative, and 0 at the very start', () => {
  assert.equal(throughputBps([], { t: 0, savedBytes: 0 }), 0)
  assert.equal(throughputBps([{ t: 0, savedBytes: 5 * MB }], { t: 2_000, savedBytes: 4 * MB }), 0)
})
