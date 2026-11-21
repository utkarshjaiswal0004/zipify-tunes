// Keep the Mac awake while songs download, so a 500-song overnight run isn't
// cut short by the Mac going to sleep.
//
// How server.js uses it:
//
//   const { createKeepAwake } = require('./keep-awake')
//   const keepAwake = createKeepAwake() // once, at boot
//
//   // around each download run:
//   const release = keepAwake.acquire(`job ${job.id}`)
//   try {
//     await runJob(...)
//   } finally {
//     release()
//   }
//
//   keepAwake.isActive() // for the page: is the Mac being kept awake now?
//
// createKeepAwake({ platform, spawnFn, pid, log } = {}) -> { acquire, isActive }
//   platform  process.platform by default. Only 'darwin' (macOS) can be kept
//             awake; anywhere else acquire() does nothing but log once.
//   spawnFn   child_process.spawn by default. Tests pass a fake: it gets
//             (command, args, options) and returns an EventEmitter with pid
//             (once started), kill() and unref(), emitting 'error' and 'exit'.
//   pid       the process caffeinate watches: this server by default.
//   log       where messages go (one string each): console.log by default.
//
// acquire(reason) -> release()
//   Downloads hold the Mac awake together: the first acquire() starts one
//   "caffeinate -i -w <pid>", later ones share it, and it's stopped when the
//   last holder calls its release(). Calling a release() again does nothing.
//   reason is a short note for the log, like 'job 3f2a'.
//
// isActive() -> boolean
//   Whether caffeinate is running for us right now: false on other systems,
//   and after caffeinate failed or quit, until a later acquire() retries.
//
// Nothing here throws. If caffeinate can't start or quits, that's logged and
// the downloads carry on; the Mac just may sleep. (-i stops idle sleep only:
// closing a MacBook's lid still puts it to sleep.)

const childProcess = require('child_process')

// macOS's own tool for this. The full path, so a different "caffeinate"
// earlier in PATH can't run in its place.
const CAFFEINATE_PATH = '/usr/bin/caffeinate'

const UNSUPPORTED_MESSAGE = 'keep-awake is only available on macOS'

// caffeinate prints nothing while it works, so it gets no pipes back to us
// (any complaint still reaches the server's own terminal). Together with
// unref() that means it can never keep the server process running.
const SPAWN_OPTIONS = { stdio: ['ignore', 'ignore', 'inherit'] }

// -i: no idle sleep (the screen may still switch off, which saves power).
// -w <pid>: caffeinate quits by itself once that process ends, so a server
// that crashes or is killed never leaves the Mac stuck awake.
function caffeinateArgs (pid) {
  return ['-i', '-w', String(pid)]
}

// Node's 'exit' gives either an exit code or the signal that ended it
function describeExit (code, signal) {
  return signal ? `signal ${signal}` : `exit code ${code}`
}

function createKeepAwake ({
  platform = process.platform,
  spawnFn = childProcess.spawn,
  pid = process.pid,
  log = console.log
} = {}) {
  const isMac = platform === 'darwin'
  let holders = [] // one per acquire() that hasn't been released yet
  let caffeinate = null // the caffeinate child running for us, if any
  let hasLoggedUnsupported = false

  function logUnsupportedOnce () {
    if (hasLoggedUnsupported) return
    hasLoggedUnsupported = true
    log(UNSUPPORTED_MESSAGE)
  }

  // Stop tracking `child` if it's the current caffeinate. Returns whether it
  // was: anything from a caffeinate we stopped ourselves is expected.
  function forget (child) {
    if (caffeinate !== child) return false
    caffeinate = null
    return true
  }

  function watch (child) {
    // Node reports a caffeinate that couldn't start (or be stopped) with an
    // 'error' event. The listener stays for good: an 'error' with no
    // listener would crash the server.
    child.on('error', (err) => {
      forget(child)
      log(`Keep Mac awake: caffeinate failed (${err.message})`)
    })
    // an 'exit' may follow that error; forget() keeps it from logging twice
    child.on('exit', (code, signal) => {
      if (!forget(child)) return // we stopped it, or its error was logged
      log(`Keep Mac awake: caffeinate quit unexpectedly (${describeExit(code, signal)})`)
    })
  }

  function start (reason) {
    let child
    try {
      child = spawnFn(CAFFEINATE_PATH, caffeinateArgs(pid), SPAWN_OPTIONS)
    } catch (err) {
      // most spawn failures arrive as an 'error' event, but some throw
      log(`Keep Mac awake: couldn't start caffeinate (${err.message})`)
      return
    }
    caffeinate = child
    watch(child)
    child.unref()
    log(reason ? `Keep Mac awake: on (${reason})` : 'Keep Mac awake: on')
  }

  function stop () {
    const child = caffeinate
    caffeinate = null // forgotten first, so its exit isn't taken for a crash
    log('Keep Mac awake: off')
    // A spawn that failed has no pid, and Node reports the failure only on
    // the next tick. kill() in between signals pid 0 (this server's whole
    // process group), so a caffeinate without a pid is left alone.
    if (!child.pid) return
    try {
      child.kill()
    } catch (err) {
      log(`Keep Mac awake: couldn't stop caffeinate (${err.message})`)
    }
  }

  function acquire (reason) {
    const holder = { reason }
    holders = [...holders, holder]
    if (!isMac) {
      logUnsupportedOnce()
    } else if (!caffeinate) {
      start(reason) // the first holder, or caffeinate failed earlier: try now
    }

    return function release () {
      if (!holders.includes(holder)) return // this holder already let go
      holders = holders.filter((other) => other !== holder)
      if (holders.length === 0 && caffeinate) stop()
    }
  }

  function isActive () {
    return caffeinate !== null
  }

  return { acquire, isActive }
}

module.exports = { createKeepAwake }
