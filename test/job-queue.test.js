const { test } = require('node:test')
const assert = require('node:assert/strict')

const { runWithLimit } = require('../job-queue')

const PAUSE_CHECK_MS = 5

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// fake "download" that records how many were running at once
function makeWork () {
  const started = []
  let running = 0
  let mostAtOnce = 0
  const work = async (index) => {
    started.push(index)
    running++
    mostAtOnce = Math.max(mostAtOnce, running)
    await sleep(10)
    running--
  }
  return { work, started, mostAtOnce: () => mostAtOnce }
}

const alwaysRun = { isPaused: () => false, shouldStop: () => false }

test('every song is worked on exactly once', async () => {
  const { work, started } = makeWork()

  await runWithLimit({ count: 7, parallel: 3, ...alwaysRun }, work)

  assert.deepEqual([...started].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6])
})

test('no more than the chosen number of songs run at once', async () => {
  const { work, mostAtOnce } = makeWork()

  await runWithLimit({ count: 10, parallel: 3, ...alwaysRun }, work)

  assert.equal(mostAtOnce(), 3)
})

test('one at a time keeps the playlist order', async () => {
  const { work, started } = makeWork()

  await runWithLimit({ count: 4, parallel: 1, ...alwaysRun }, work)

  assert.deepEqual(started, [0, 1, 2, 3])
})

test('stop lets running songs finish but starts no new ones', async () => {
  const { work, started } = makeWork()
  let stop = false
  const stopAfterTwo = async (index) => {
    await work(index)
    if (started.length >= 2) stop = true
  }

  await runWithLimit(
    { count: 10, parallel: 2, isPaused: () => false, shouldStop: () => stop },
    stopAfterTwo
  )

  assert.equal(started.length, 2)
})

test('pause holds new songs back until resumed', async () => {
  const { work, started } = makeWork()
  let paused = true

  const run = runWithLimit(
    {
      count: 3,
      parallel: 2,
      isPaused: () => paused,
      shouldStop: () => false,
      pauseCheckMs: PAUSE_CHECK_MS
    },
    work
  )
  await sleep(40)
  const startedWhilePaused = started.length
  paused = false
  await run

  assert.equal(startedWhilePaused, 0)
  assert.equal(started.length, 3)
})

test('stopping while paused ends the run without starting anything', async () => {
  const { work, started } = makeWork()
  let stop = false

  const run = runWithLimit(
    {
      count: 3,
      parallel: 2,
      isPaused: () => !stop,
      shouldStop: () => stop,
      pauseCheckMs: PAUSE_CHECK_MS
    },
    work
  )
  await sleep(20)
  stop = true
  await run

  assert.equal(started.length, 0)
})

// --- changing the limit while the run goes on ---

// fake "download" that keeps going until finishAll(), so a test can count how
// many are running at a given moment
function makeHeldWork () {
  let running = 0
  let finishAll
  const finished = new Promise((resolve) => {
    finishAll = resolve
  })
  const work = async () => {
    running++
    await finished
    running--
  }
  return { work, running: () => running, finishAll }
}

test('raising the limit mid-run starts more songs at once', async () => {
  const { work, running, finishAll } = makeHeldWork()
  let limit = 1

  const run = runWithLimit(
    { count: 5, parallel: () => limit, ...alwaysRun, pauseCheckMs: PAUSE_CHECK_MS },
    work
  )
  await sleep(20)
  const runningBefore = running()
  limit = 3
  await sleep(20) // a few checks later
  const runningAfter = running()
  finishAll()
  await run

  assert.equal(runningBefore, 1)
  assert.equal(runningAfter, 3)
})

test('lowering the limit lets running songs finish, then keeps to the new limit', async () => {
  let limit = 3
  let running = 0
  let release
  const released = new Promise((resolve) => {
    release = resolve
  })
  const started = []
  const runningAsLaterSongsStart = []
  // the first three run until released, the rest are quick
  const work = async (index) => {
    started.push(index)
    running++
    if (index < 3) {
      await released
    } else {
      runningAsLaterSongsStart.push(running)
      await sleep(5)
    }
    running--
  }

  const run = runWithLimit(
    { count: 6, parallel: () => limit, ...alwaysRun, pauseCheckMs: PAUSE_CHECK_MS },
    work
  )
  await sleep(20)
  const runningWhenLowered = running
  limit = 1
  release()
  await run

  assert.equal(runningWhenLowered, 3, 'songs already running are left to finish')
  assert.deepEqual(runningAsLaterSongsStart, [1, 1, 1], 'then one at a time')
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5], 'every song still runs, in order')
})

test('a song that throws anyway starts nothing new, and the run fails once the rest finish', async () => {
  const started = []
  const finished = []
  const work = async (index) => {
    started.push(index)
    if (index === 0) throw new Error('song 0 broke')
    await sleep(10)
    finished.push(index)
  }

  await assert.rejects(runWithLimit({ count: 6, parallel: 2, ...alwaysRun }, work), /song 0 broke/)

  assert.deepEqual(started, [0, 1], 'nothing new after the error')
  assert.deepEqual(finished, [1], 'the song already running finished first')
})
