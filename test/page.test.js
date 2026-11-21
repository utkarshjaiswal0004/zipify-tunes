const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// app.js is the page's classic script. Run it the way the browser does
// (after charts.js, sharing one global), against a stand-in for the page
// elements it wires up on load. Its function declarations become globals of
// that page, which is how these tests reach its helpers.
function loadPage () {
  const elements = new Map()
  const element = () => ({ addEventListener () {}, value: '', options: [], dataset: {} })
  const page = {
    document: {
      getElementById (id) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      }
    },
    fetch: () => Promise.reject(new Error('offline in tests')),
    addEventListener () {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
  page.window = page
  vm.createContext(page)
  for (const file of ['charts.js', 'app.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    vm.runInContext(source, page, { filename: file })
  }
  return page
}

const page = loadPage()

const MINUTE = 60_000
const MB = 1024 * 1024

// the countdown after one poll of a running job
function countdownFrom (etaMs, { done = 3, control = 'run', now = 0 } = {}) {
  return page.nextCountdown(null, { etaMs, done, control }, now)
}

// --- the countdown ---

test('the countdown starts from the server estimate and runs down each second', () => {
  const countdown = countdownFrom(5 * MINUTE)

  assert.equal(page.countdownView(countdown, 0).value, '5:00')
  assert.equal(page.countdownView(countdown, 1000).value, '4:59')
  assert.equal(page.countdownView(countdown, 61_000).value, '3:59')
})

test('polls between two finished songs do not wind the countdown back up', () => {
  // the server's estimate stays 5:00 until another song finishes
  const first = countdownFrom(5 * MINUTE)
  const later = page.nextCountdown(first, { etaMs: 5 * MINUTE, done: 3, control: 'run' }, 10_000)

  assert.equal(page.countdownView(later, 10_000).value, '4:50')
})

test('a new estimate close to the countdown is eased in rather than jumped to', () => {
  // 4:30 showing when the server says 4:00: about 11% off
  const first = countdownFrom(5 * MINUTE)
  const next = page.nextCountdown(first, { etaMs: 4 * MINUTE, done: 4, control: 'run' }, 30_000)

  // 15% of the way there: 4:30 - 4.5 s
  assert.equal(page.countdownView(next, 30_000).value, '4:26')
})

test('repeated polls close the gap to a new estimate a little at a time', () => {
  // a song finishes 30 s in and the estimate drops to 4:00, where it holds
  // still until the next song: 3:30 left as of 60 s
  let countdown = countdownFrom(5 * MINUTE)
  let previous = page.remainingAt(countdown, 30_000)
  for (let at = 30_000; at <= 60_000; at += 1000) {
    countdown = page.nextCountdown(countdown, { etaMs: 4 * MINUTE, done: 4, control: 'run' }, at)
    const shown = page.remainingAt(countdown, at)

    assert.ok(shown <= previous, `${previous} -> ${shown} ms at ${at}: it only counts down`)
    assert.ok(previous - shown <= 6000, `${previous} -> ${shown} ms at ${at} is a jump`)
    previous = shown
  }

  assert.ok(Math.abs(previous - 3.5 * MINUTE) < 1000, `${previous} ms is close to 3:30`)
})

test('an estimate a quarter or more away is a real change: the countdown snaps to it', () => {
  const first = countdownFrom(5 * MINUTE) // 4:30 showing at 30 s
  const faster = page.nextCountdown(first, { etaMs: 2 * MINUTE, done: 4, control: 'run' }, 30_000)
  const slower = page.nextCountdown(first, { etaMs: 8 * MINUTE, done: 4, control: 'run' }, 30_000)

  assert.equal(page.countdownView(faster, 30_000).value, '2:00')
  assert.equal(page.countdownView(slower, 30_000).value, '8:00')
})

test('the shown time moves 15% of the way to an estimate less than a quarter off', () => {
  // 10 s of the run since the last poll: room enough for the whole 15%
  assert.equal(page.easedRemainingMs(100_000, 110_000, 10_000), 101_500)
  assert.equal(page.easedRemainingMs(100_000, 90_000, 10_000), 98_500)
})

test('the shown time snaps to a first estimate, or to one a quarter or more off', () => {
  assert.equal(page.easedRemainingMs(null, 90_000, 1000), 90_000)
  assert.equal(page.easedRemainingMs(100_000, 125_000, 1000), 125_000)
  assert.equal(page.easedRemainingMs(100_000, 70_000, 1000), 70_000)
  assert.equal(page.easedRemainingMs(0, 5000, 1000), 5000)
})

test('easing runs the countdown at half speed at the slowest, 4x at the fastest', () => {
  // a second of the run: at most half a second back up, 3 s further down
  assert.equal(page.easedRemainingMs(100_000, 120_000, 1000), 100_500)
  assert.equal(page.easedRemainingMs(200_000, 160_000, 1000), 197_000)
  // no time run since the last poll: nothing to ease with
  assert.equal(page.easedRemainingMs(100_000, 110_000, 0), 100_000)
})

test('the countdown never counts up while it eases toward a later finish', () => {
  const first = countdownFrom(271_000) // 4:31
  const next = page.nextCountdown(first, { etaMs: 310_000, done: 4, control: 'run' }, 1000) // 14% more

  assert.ok(page.remainingAt(next, 1000) < 271_000)
  assert.ok(page.remainingAt(next, 1000) >= 270_000)
})

test('between two finished songs a creeping estimate is followed, eased in: the countdown slows, never hops', () => {
  // with few songs done the server's estimate grows each second until the next one finishes
  const first = page.nextCountdown(null, { etaMs: 819_000, done: 1, total: 500, control: 'run' }, 21_000)
  const next = page.nextCountdown(first, { etaMs: 858_000, done: 1, total: 500, control: 'run' }, 22_000)

  // half a second down for the second that passed, not a jump up to 14:17
  assert.equal(page.remainingAt(next, 22_000), 818_500)
})

test('at a steady pace the estimate holding still between songs leaves the countdown at one second a second', () => {
  // 10 s a song: the server says 15:00 until the next song finishes, 14:50 after it
  let countdown = page.nextCountdown(null, { etaMs: 900_000, done: 10, total: 100, control: 'run' }, 0)
  for (let at = 1000; at < 10_000; at += 1000) {
    countdown = page.nextCountdown(countdown, { etaMs: 900_000, done: 10, total: 100, control: 'run' }, at)

    assert.equal(page.remainingAt(countdown, at), 900_000 - at)
  }
  countdown = page.nextCountdown(countdown, { etaMs: 890_000, done: 11, total: 100, control: 'run' }, 10_000)

  assert.equal(page.remainingAt(countdown, 10_000), 890_000)
})

test('while no song finishes for longer than a song takes, the countdown follows the estimate up by slowing down', () => {
  // 10 s a song, then a stall: the estimate creeps up 2 s every second
  let countdown = page.nextCountdown(null, { etaMs: 900_000, done: 10, total: 100, control: 'run' }, 0)
  let previous = page.remainingAt(countdown, 0)
  for (let at = 1000; at <= 60_000; at += 1000) {
    const etaMs = 900_000 + Math.max(0, at - 10_000) * 2
    countdown = page.nextCountdown(countdown, { etaMs, done: 10, total: 100, control: 'run' }, at)
    const shown = page.remainingAt(countdown, at)

    assert.ok(shown < previous, `${previous} -> ${shown} ms at ${at}: it never counts up or stalls`)
    assert.ok(previous - shown >= 500, `${previous} -> ${shown} ms at ${at}: at least half speed`)
    previous = shown
  }

  // a plain run-down would be at 14:00 by now
  assert.ok(previous > 900_000 - 60_000 + 10_000, `${previous} ms: it followed the estimate up`)
})

test('once every song left is under way the estimate counts down by itself, and the countdown just follows it', () => {
  // 3 songs left, all 3 running: the run ends when the slowest of them does
  const last = { done: 97, total: 100, activeCount: 3, control: 'run' }
  let countdown = page.nextCountdown(null, { ...last, etaMs: 50_000 }, 0)
  for (let at = 1000; at <= 5000; at += 1000) {
    countdown = page.nextCountdown(countdown, { ...last, etaMs: 50_000 - at }, at)

    assert.equal(page.remainingAt(countdown, at), 50_000 - at)
  }
})

test('an estimate that creeps far off between songs is still eased in, not snapped to', () => {
  const first = page.nextCountdown(null, { etaMs: 20_000, done: 99, total: 100, control: 'run' }, 0)
  const next = page.nextCountdown(first, { etaMs: 60_000, done: 99, total: 100, control: 'run' }, 1000)

  assert.equal(page.remainingAt(next, 1000), 19_500)
})

test('a changed limit makes a changed estimate news', () => {
  const first = page.nextCountdown(null, { etaMs: 10 * MINUTE, done: 3, parallel: 3, control: 'run' }, 0)
  const next = page.nextCountdown(first, { etaMs: 5 * MINUTE, done: 3, parallel: 6, control: 'run' }, 1000)

  assert.equal(page.countdownView(next, 1000).value, '5:00')
})

test('an estimate that goes missing mid-run leaves the countdown running down', () => {
  const next = page.nextCountdown(countdownFrom(5 * MINUTE), { etaMs: null, done: 3, control: 'run' }, 10_000)

  assert.equal(page.countdownView(next, 10_000).value, '4:50')
  assert.equal(page.countdownView(next, 20_000).value, '4:40')
})

test('"done around" follows the time shown, not the raw estimate', () => {
  const noon = new Date(2026, 0, 15, 12, 0, 0).getTime()
  const first = page.nextCountdown(null, { etaMs: 10 * MINUTE, done: 3, control: 'run' }, noon)
  // a second later, an estimate 20% lower is eased in: 9:59 - 3 s shows, not 8:00
  const next = page.nextCountdown(first, { etaMs: 8 * MINUTE, done: 4, control: 'run' }, noon + 1000)
  const view = page.countdownView(next, noon + 1000)

  assert.equal(view.value, '9:56')
  assert.match(view.note, /^done around 12[:.]09/)
})

test('the countdown ticks just after each whole second of the time left', () => {
  const countdown = countdownFrom(4500)

  assert.ok(page.countdownTickDelay(countdown, 0) >= 500 && page.countdownTickDelay(countdown, 0) < 600)
  assert.ok(page.countdownTickDelay(countdown, 500) >= 1000 && page.countdownTickDelay(countdown, 500) < 1100)
  assert.equal(page.countdownTickDelay(countdownFrom(4500, { control: 'pause' }), 0), 1000)
  assert.equal(page.countdownTickDelay(null, 0), 1000)
})

test('the countdown stops at 0:00 rather than going below', () => {
  const view = page.countdownView(countdownFrom(2000), 60_000)

  assert.equal(view.value, '0:00')
  assert.equal(view.state, 'running')
})

test('an hour or more reads as h:mm:ss', () => {
  assert.equal(page.countdownView(countdownFrom(3_723_000), 0).value, '1:02:03')
})

test('a part second still left reads as a whole second, not as 0:00', () => {
  assert.equal(page.countdownView(countdownFrom(1500), 1000).value, '0:01')
})

test('the countdown says around when the run will be done, in local time', () => {
  const noon = new Date(2026, 0, 15, 12, 0, 0).getTime() // done the same day
  const view = page.countdownView(countdownFrom(5 * MINUTE, { now: noon }), noon)

  assert.match(view.note, /^done around \d{1,2}[:.]\d{2}/)
})

test('a finish after midnight says tomorrow', () => {
  const lateEvening = new Date(2026, 0, 15, 23, 50, 0).getTime()
  const sameDay = page.countdownView(countdownFrom(5 * MINUTE, { now: lateEvening }), lateEvening)
  const nextDay = page.countdownView(countdownFrom(85 * MINUTE, { now: lateEvening }), lateEvening)

  assert.doesNotMatch(sameDay.note, /tomorrow/)
  assert.match(nextDay.note, /^done around 1[:.]15\D.*tomorrow$/)
})

test('a finish two or more days away names the day', () => {
  const evening = new Date(2026, 0, 15, 20, 0, 0).getTime()
  const finish = new Date(2026, 0, 17, 2, 0, 0) // 30 hours later
  const view = page.countdownView(countdownFrom(30 * 60 * MINUTE, { now: evening }), evening)

  assert.doesNotMatch(view.note, /tomorrow/)
  assert.ok(view.note.includes(finish.toLocaleDateString([], { weekday: 'short' })), view.note)
})

test('before any song is done the time left is still being worked out', () => {
  const view = page.countdownView(countdownFrom(null, { done: 0 }), 0)

  assert.equal(view.value, 'Working out…')
  assert.equal(view.state, 'pending')
})

test('a paused run freezes the countdown and says so', () => {
  const running = countdownFrom(5 * MINUTE)
  const paused = page.nextCountdown(running, { etaMs: 5 * MINUTE, done: 3, control: 'pause' }, 10_000)
  const view = page.countdownView(paused, 70_000)

  assert.equal(view.state, 'paused')
  assert.equal(view.value, '4:50')
  assert.match(view.note, /paused/i)
})

test('resuming carries on from where the countdown froze', () => {
  const running = countdownFrom(5 * MINUTE)
  const paused = page.nextCountdown(running, { etaMs: 5 * MINUTE, done: 3, control: 'pause' }, 10_000)
  const resumed = page.nextCountdown(paused, { etaMs: 5 * MINUTE, done: 3, control: 'run' }, 100_000)

  assert.equal(page.countdownView(resumed, 105_000).value, '4:45')
})

test('a new estimate while paused leaves the frozen countdown alone until the run resumes', () => {
  const running = countdownFrom(5 * MINUTE)
  const paused = page.nextCountdown(running, { etaMs: 5 * MINUTE, done: 3, control: 'pause' }, 10_000)
  // songs already downloading finish while paused, and the estimate drops
  const later = page.nextCountdown(paused, { etaMs: 2 * MINUTE, done: 5, control: 'pause' }, 40_000)
  const resumed = page.nextCountdown(later, { etaMs: 2 * MINUTE, done: 5, control: 'run' }, 70_000)

  assert.equal(page.countdownView(later, 60_000).value, '4:50')
  assert.equal(page.countdownView(resumed, 70_000).value, '2:00')
})

test('a paused run with no estimate yet just says Paused', () => {
  const view = page.countdownView(countdownFrom(null, { done: 0, control: 'pause' }), 0)

  assert.equal(view.value, 'Paused')
  assert.equal(view.state, 'paused')
})

test('stopping shows Stopping… instead of a time', () => {
  const view = page.countdownView(countdownFrom(5 * MINUTE, { control: 'stop' }), 0)

  assert.equal(view.value, 'Stopping…')
  assert.equal(view.state, 'stopping')
})

test('stopping does not promise that songs downloading finish first: Stop cancels them', () => {
  const view = page.countdownView(countdownFrom(5 * MINUTE, { control: 'stop' }), 0)

  assert.doesNotMatch(view.note, /finish first/)
  assert.match(view.note, /cancel/)
})

test('once the run is over the countdown says how it ended', () => {
  assert.equal(page.finalCountdownView('done', Date.now()).value, 'Done')
  assert.match(page.finalCountdownView('done', Date.now()).note, /^finished at /)
  assert.equal(page.finalCountdownView('stopped', Date.now()).value, 'Stopped')
  assert.equal(page.finalCountdownView('failed', Date.now()).state, 'failed')
})

test('a run stopped before saving anything says nothing was saved', () => {
  assert.equal(page.finalCountdownView('stopped', Date.now()).note, 'songs already saved are kept')
  assert.equal(page.finalCountdownView('stopped', Date.now(), false).note, 'nothing was saved')
})

// --- changing how many download at once, mid-run ---

test('the live control says how many songs are in progress (searching, downloading, converting or tagging)', () => {
  assert.equal(page.runningNowText(3, 3), '3 songs in progress')
  assert.equal(page.runningNowText(1, 3), '1 song in progress')
  assert.equal(page.runningNowText(0, 3), '0 songs in progress')
})

test('after lowering the limit it says how many finish before the new limit applies', () => {
  assert.equal(page.runningNowText(6, 3), '6 songs in progress · finishing 3 first, then 3 at once')
  assert.equal(page.runningNowText(4, 3), '4 songs in progress · finishing 1 first, then 3 at once')
})

test('once nothing new can start (stopping, or the run is over) only the songs in progress are counted', () => {
  assert.equal(page.runningNowText(6, 3, false), '6 songs in progress')
})

test('a change made while paused says it applies once the run resumes', () => {
  assert.equal(page.parallelChangedText(10, 0, 'pause'), 'Up to 10 at once when you resume.')
  assert.equal(page.parallelChangedText(10, 6, 'run'), 'Now downloading up to 10 at once.')
  assert.equal(page.parallelChangedText(2, 6, 'run'), 'Now downloading up to 2 at once. Songs already in progress finish first.')
})

test('a poll carries the server limit only when no change was on its way or answered meanwhile', () => {
  assert.equal(page.isPollParallelFresh({ isSending: false, answersAtPoll: 2, answers: 2 }), true)
  assert.equal(page.isPollParallelFresh({ isSending: true, answersAtPoll: 2, answers: 2 }), false)
  assert.equal(page.isPollParallelFresh({ isSending: false, answersAtPoll: 1, answers: 2 }), false)
})

test('only the latest choice is sent, one change at a time', () => {
  assert.equal(page.parallelToSend({ pending: 5, server: 3, isSending: false }), 5)
  // sent once the change on its way is answered
  assert.equal(page.parallelToSend({ pending: 5, server: 3, isSending: true }), null)
  // back to where the server already is: nothing to send
  assert.equal(page.parallelToSend({ pending: 3, server: 3, isSending: false }), null)
  assert.equal(page.parallelToSend({ pending: null, server: 3, isSending: false }), null)
})

test('an answered change settles the choice, unless another number was picked meanwhile', () => {
  assert.equal(page.pendingAfterAnswer(5, 5), null)
  assert.equal(page.pendingAfterAnswer(6, 5), 6)
  assert.equal(page.pendingAfterAnswer(null, 5), null)
})

test('the live control works only while a run goes, paused or not, and not once stopping', () => {
  const running = { status: 'running', control: 'run' }

  assert.equal(page.canChangeParallel(running, true), true)
  assert.equal(page.canChangeParallel({ status: 'running', control: 'pause' }, true), true)
  assert.equal(page.canChangeParallel({ status: 'running', control: 'stop' }, true), false)
  assert.equal(page.canChangeParallel({ status: 'saved', control: 'run' }, true), false)
  assert.equal(page.canChangeParallel(running, false), false)
})

test('the slider reads its value out in words', () => {
  assert.equal(page.parallelValueText(1), '1 song at a time')
  assert.equal(page.parallelValueText(5), '5 songs at once')
})

// --- the Live stats card ---

test('the Live stats card needs the history and recent songs from the server', () => {
  assert.equal(page.hasLiveStats({ history: [], recent: [] }), true)
  assert.equal(page.hasLiveStats({ done: 3, total: 10 }), false) // an older server
  assert.equal(page.hasLiveStats(null), false)
})

test('the outcome ring counts songs the way the run panel does', () => {
  const parts = page.outcomeParts({
    total: 37,
    done: 12,
    savedCount: 9,
    skippedCount: 1,
    reviewCount: 1
  })

  assert.equal(parts.saved, 9)
  assert.equal(parts.skipped, 1)
  assert.equal(parts.review, 1)
  assert.equal(parts.failed, 1)
  assert.equal(parts.left, 25)
})

function sumOf (parts) {
  return Object.values(parts).reduce((sum, count) => sum + count, 0)
}

test('picks a stopped or failed "Download selected" run put back are not counted twice in the ring', () => {
  const snapshots = [
    // 3 picks, stopped before any was saved: all 3 back on the review list
    { total: 3, done: 0, savedCount: 0, reviewCount: 3 },
    // 10 picks, 2 saved, then Stop: 8 back on the list
    { total: 10, done: 2, savedCount: 2, reviewCount: 8 },
    // 10 picks into a ZIP, all saved, then the ZIP failed: all 10 listed again
    { total: 10, done: 10, savedCount: 10, reviewCount: 10 }
  ]

  for (const job of snapshots) {
    const parts = page.outcomeParts(job)

    assert.equal(sumOf(parts), job.total, JSON.stringify(parts))
    assert.equal(job.total - parts.left, job.done, JSON.stringify(parts))
  }
})

test('the ring of a CSV run adds up to its song count, reused songs included', () => {
  const parts = page.outcomeParts({ total: 500, done: 105, savedCount: 80, reusedCount: 5, skippedCount: 20, reviewCount: 3 })

  assert.deepEqual({ ...parts }, { saved: 75, reused: 5, skipped: 20, review: 3, failed: 2, left: 395 })
})

test('a saved song shows its size and how long it took', () => {
  const view = page.recentView({
    number: 12,
    title: 'Song',
    artist: 'Band',
    outcome: 'saved',
    bytes: 4.2 * MB,
    tookMs: 38_000,
    reason: null
  })

  assert.equal(view.chip, '✓ saved')
  assert.equal(view.title, '12. Song — Band')
  assert.equal(view.details, '4.2 MB · 38 s')
  assert.equal(view.reason, '')
})

test('a skipped song shows no size or time', () => {
  const view = page.recentView({
    number: 3,
    title: 'Song',
    artist: 'Band',
    outcome: 'skipped',
    bytes: null,
    tookMs: null,
    reason: null
  })

  assert.equal(view.chip, '↷ skipped')
  assert.equal(view.details, '')
})

test('songs to review and failed songs show their reason', () => {
  const review = page.recentView({
    number: 4,
    title: 'Song',
    artist: 'Band',
    outcome: 'review',
    bytes: null,
    tookMs: 12_000,
    reason: 'No exact match'
  })
  const failed = page.recentView({
    number: 5,
    title: 'Song',
    artist: 'Band',
    outcome: 'failed',
    bytes: null,
    tookMs: 61_000,
    reason: 'Download failed'
  })

  assert.equal(review.chip, '? review')
  assert.equal(review.reason, 'No exact match')
  assert.equal(review.details, '12 s')
  assert.equal(failed.chip, '✗ failed')
  assert.equal(failed.reason, 'Download failed')
  assert.equal(failed.details, '1 min 1 s')
})

test('a song with no artist is not left with a dangling dash', () => {
  const view = page.recentView({ number: 7, title: 'Intro', artist: '', outcome: 'saved', bytes: MB, tookMs: 1000 })

  assert.equal(view.title, '7. Intro')
})

test('the speed chart is captioned as the saving speed over the last 30 s', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')

  assert.match(html, /Saving speed \(last 30 s\)/)
  assert.doesNotMatch(html, /Download speed/)
})

test('the songs in progress are not a live region read out on every poll', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const [list] = html.match(/<ul[^>]*id="activeSongs"[^>]*>/)

  assert.doesNotMatch(list, /aria-live/)
  assert.match(html, /id="parallelRunning"[^>]*>0 songs in progress</)
})

test('the review list has a Clear list button', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')

  assert.match(html, /<button[^>]*id="reviewClear"[^>]*>Clear list<\/button>/)
})

test('app.js never builds markup from strings', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')

  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/)
})
