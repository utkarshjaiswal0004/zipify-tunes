// Working through a playlist's songs a few at a time, with pause and stop,
// and a limit that can change while the run goes on.

// how often a paused run, or one at its limit, checks whether it may start
// another song (a song finishing wakes it straight away)
const PAUSE_CHECK_MS = 250

function doNothing () {}

// at least one at a time, so a bad limit can't stall the run for good
function usableLimit (limit) {
  return Math.max(1, Math.floor(limit)) || 1
}

// Run work(index) for every index 0…count-1, in order, with at most
// `parallel` running at once. `parallel` is a number, or a function giving
// the current limit: it's read before each start, so raising it starts more
// songs within pauseCheckMs, and lowering it lets the songs already running
// finish, starting nothing new until fewer than the new limit are running.
// Before starting each one it waits while isPaused(); once shouldStop() is
// true it starts nothing new, and songs already running finish. Resolves when
// everything that was started has finished.
// work() must handle its own errors (one bad song shouldn't end the run). If
// one throws anyway, nothing new starts and the run rejects with that error
// once the songs already running have finished, so nothing is left running
// behind the caller's back.
async function runWithLimit (
  { count, parallel, isPaused, shouldStop, pauseCheckMs = PAUSE_CHECK_MS },
  work
) {
  const currentLimit = typeof parallel === 'function' ? parallel : () => parallel
  const running = new Set()
  const errors = []
  let next = 0
  let wakeUp = doNothing

  // Wait until a song finishes (its slot is free at once) or pauseCheckMs
  // passes (to notice a resume or a raised limit), whichever comes first
  function waitForChange () {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        wakeUp = doNothing
        resolve()
      }
      const timer = setTimeout(wake, pauseCheckMs)
      wakeUp = wake
    })
  }

  function start (index) {
    const song = Promise.resolve()
      .then(() => work(index))
      .catch((error) => {
        errors.push(error)
      })
      .finally(() => {
        running.delete(song)
        wakeUp()
      })
    running.add(song)
  }

  while (!errors.length && next < count && !shouldStop()) {
    if (isPaused() || running.size >= usableLimit(currentLimit())) {
      await waitForChange()
    } else {
      start(next++)
    }
  }
  await Promise.all(running)
  if (errors.length) throw errors[0]
}

module.exports = { runWithLimit }
