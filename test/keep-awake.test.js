const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { createKeepAwake } = require('../keep-awake')

// Every test uses a fake spawnFn: no real caffeinate starts, so these run
// the same on any system and never touch the Mac's sleep settings.

const SERVER_PID = 4321
const FAKE_CAFFEINATE_PID = 9876
const UNSUPPORTED_MESSAGE = /keep-awake is only available on macOS/

// A stand-in for the caffeinate child. kill() only records the call (the
// real child exits a moment later), so a test emits 'exit' itself when that
// matters. onKill lets a test make kill() fail the ways Node's can.
function makeFakeChild ({ hasStarted = true, onKill = () => true } = {}) {
  const child = new EventEmitter()
  // Node only gives a child a pid once it has really started
  child.pid = hasStarted ? FAKE_CAFFEINATE_PID : undefined
  child.killCalls = 0
  child.unrefCalls = 0
  child.kill = () => {
    child.killCalls++
    return onKill(child)
  }
  child.unref = () => {
    child.unrefCalls++
  }
  return child
}

// spawnFn stand-in: hands out fake children and remembers each call
function makeFakeSpawn (childOptions) {
  const calls = []
  const children = []
  function spawnFn (command, args, options) {
    calls.push({ command, args, options })
    const child = makeFakeChild(childOptions)
    children.push(child)
    return child
  }
  return { spawnFn, calls, children }
}

function makeLog () {
  const lines = []
  return { log: (...parts) => lines.push(parts.join(' ')), lines }
}

// A keep-awake on a pretend Mac, plus everything a test needs to look at
function makeMacKeepAwake (childOptions) {
  const { spawnFn, calls, children } = makeFakeSpawn(childOptions)
  const { log, lines } = makeLog()
  const keepAwake = createKeepAwake({ platform: 'darwin', spawnFn, pid: SERVER_PID, log })
  return { keepAwake, calls, children, lines }
}

// errors shaped like Node's: a message plus an errno code
function errnoError (message, code) {
  return Object.assign(new Error(message), { code })
}

// --- one caffeinate, shared by every download ---

test('the first download starts caffeinate -i -w <server pid>', () => {
  const { keepAwake, calls } = makeMacKeepAwake()

  keepAwake.acquire('job A')

  assert.equal(calls.length, 1)
  assert.match(calls[0].command, /(^|\/)caffeinate$/)
  assert.deepEqual(calls[0].args, ['-i', '-w', String(SERVER_PID)])
  assert.equal(keepAwake.isActive(), true)
})

test('caffeinate watches the server process itself by default', () => {
  const { spawnFn, calls } = makeFakeSpawn()
  const keepAwake = createKeepAwake({ platform: 'darwin', spawnFn, log: () => {} })

  keepAwake.acquire('job A')

  assert.deepEqual(calls[0].args, ['-i', '-w', String(process.pid)])
})

test('two downloads at once share one caffeinate', () => {
  const { keepAwake, calls } = makeMacKeepAwake()

  keepAwake.acquire('job A')
  keepAwake.acquire('job B')

  assert.equal(calls.length, 1)
  assert.equal(keepAwake.isActive(), true)
})

test('caffeinate is stopped only when the last download lets go', () => {
  const { keepAwake, children } = makeMacKeepAwake()
  const releaseA = keepAwake.acquire('job A')
  const releaseB = keepAwake.acquire('job B')

  releaseA()
  const killsWhileBHolds = children[0].killCalls
  const isActiveWhileBHolds = keepAwake.isActive()
  releaseB()

  assert.equal(killsWhileBHolds, 0)
  assert.equal(isActiveWhileBHolds, true)
  assert.equal(children[0].killCalls, 1)
  assert.equal(keepAwake.isActive(), false)
})

test('releasing twice does not let the Mac sleep during another download', () => {
  const { keepAwake, children } = makeMacKeepAwake()
  const releaseA = keepAwake.acquire('job A')
  keepAwake.acquire('job B')

  releaseA()
  releaseA()

  assert.equal(children[0].killCalls, 0)
  assert.equal(keepAwake.isActive(), true)
})

test('releasing twice after the last download stops caffeinate only once', () => {
  const { keepAwake, children } = makeMacKeepAwake()
  const release = keepAwake.acquire('job A')

  release()
  release()

  assert.equal(children[0].killCalls, 1)
})

test('a download after the others finished starts a fresh caffeinate', () => {
  const { keepAwake, calls } = makeMacKeepAwake()
  const releaseA = keepAwake.acquire('job A')
  releaseA()

  keepAwake.acquire('job B')

  assert.equal(calls.length, 2)
  assert.equal(keepAwake.isActive(), true)
})

test('caffeinate never keeps the server process running by itself', () => {
  const { keepAwake, calls, children } = makeMacKeepAwake()

  keepAwake.acquire('job A')

  // no pipes back to the server, and unref'd: the server can still exit,
  // and -w <pid> then ends caffeinate too
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'inherit'])
  assert.equal(children[0].unrefCalls, 1)
})

test('the log says why the Mac is kept awake', () => {
  const { keepAwake, lines } = makeMacKeepAwake()

  keepAwake.acquire('downloading Road Trip')

  assert.equal(lines.length, 1)
  assert.match(lines[0], /Road Trip/)
})

test('a download can hold the Mac awake without giving a reason', () => {
  const { keepAwake, lines } = makeMacKeepAwake()

  const release = keepAwake.acquire()
  release()

  assert.equal(lines.length, 2)
  assert.ok(lines.every((line) => !/undefined/.test(line)))
})

test('stopping caffeinate ourselves is not reported as a problem', () => {
  const { keepAwake, children, lines } = makeMacKeepAwake()
  const release = keepAwake.acquire('job A')
  release()
  const linesBeforeExit = lines.length

  children[0].emit('exit', null, 'SIGTERM')

  assert.equal(lines.length, linesBeforeExit)
})

test('the old caffeinate exiting late does not stop the new one', () => {
  const { keepAwake, children, lines } = makeMacKeepAwake()
  const releaseA = keepAwake.acquire('job A')
  releaseA()
  keepAwake.acquire('job B')
  const linesBeforeExit = lines.length

  children[0].emit('exit', null, 'SIGTERM')

  assert.equal(keepAwake.isActive(), true)
  assert.equal(lines.length, linesBeforeExit)
})

// --- other systems ---

test('other systems never start caffeinate and say so once', () => {
  const { spawnFn, calls } = makeFakeSpawn()
  const { log, lines } = makeLog()
  const keepAwake = createKeepAwake({ platform: 'linux', spawnFn, pid: SERVER_PID, log })

  const releaseA = keepAwake.acquire('job A')
  keepAwake.acquire('job B')
  releaseA()
  releaseA()
  keepAwake.acquire('job C')

  assert.equal(calls.length, 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0], UNSUPPORTED_MESSAGE)
  assert.equal(keepAwake.isActive(), false)
})

test('Windows is not kept awake either', () => {
  const { spawnFn, calls } = makeFakeSpawn()
  const keepAwake = createKeepAwake({ platform: 'win32', spawnFn, log: () => {} })

  const release = keepAwake.acquire('job A')
  release()

  assert.equal(calls.length, 0)
  assert.equal(keepAwake.isActive(), false)
})

// --- when caffeinate can't run ---

test('an error event from caffeinate is logged once, not thrown', () => {
  const { keepAwake, children, lines } = makeMacKeepAwake()
  keepAwake.acquire('job A')
  const linesBefore = lines.length
  const child = children[0]

  assert.doesNotThrow(() =>
    child.emit('error', errnoError('spawn /usr/bin/caffeinate ENOENT', 'ENOENT'))
  )
  // Node may follow an error with an exit for the same failure
  child.emit('exit', 1, null)

  const problemLines = lines.slice(linesBefore)
  assert.equal(problemLines.length, 1)
  assert.match(problemLines[0], /ENOENT/)
  assert.equal(keepAwake.isActive(), false)
})

test('after an error, the next download tries caffeinate again', () => {
  const { keepAwake, calls, children } = makeMacKeepAwake()
  keepAwake.acquire('job A')
  children[0].emit('error', errnoError('spawn /usr/bin/caffeinate EAGAIN', 'EAGAIN'))

  keepAwake.acquire('job B')

  assert.equal(calls.length, 2)
  assert.equal(keepAwake.isActive(), true)
})

test('a spawn that throws is logged once and tried again later', () => {
  const fake = makeFakeSpawn()
  const { log, lines } = makeLog()
  let attempts = 0
  const failFirstSpawn = (...args) => {
    attempts++
    if (attempts === 1) throw errnoError('spawn EBADF', 'EBADF')
    return fake.spawnFn(...args)
  }
  const keepAwake = createKeepAwake({
    platform: 'darwin',
    spawnFn: failFirstSpawn,
    pid: SERVER_PID,
    log
  })

  assert.doesNotThrow(() => keepAwake.acquire('job A'))
  const linesAfterFailure = [...lines]
  const isActiveAfterFailure = keepAwake.isActive()
  keepAwake.acquire('job B')

  assert.equal(linesAfterFailure.length, 1)
  assert.match(linesAfterFailure[0], /EBADF/)
  assert.equal(isActiveAfterFailure, false)
  assert.equal(attempts, 2)
  assert.equal(keepAwake.isActive(), true)
})

test('caffeinate quitting unexpectedly is logged once and retried later', () => {
  const { keepAwake, calls, children, lines } = makeMacKeepAwake()
  keepAwake.acquire('job A')
  const linesBefore = lines.length

  children[0].emit('exit', null, 'SIGKILL')
  const problemLines = lines.slice(linesBefore)
  const isActiveAfterExit = keepAwake.isActive()
  keepAwake.acquire('job B')

  assert.equal(problemLines.length, 1)
  assert.match(problemLines[0], /SIGKILL/)
  assert.equal(isActiveAfterExit, false)
  assert.equal(calls.length, 2)
  assert.equal(keepAwake.isActive(), true)
})

test('caffeinate ending with an exit code reports that code', () => {
  const { keepAwake, children, lines } = makeMacKeepAwake()
  keepAwake.acquire('job A')

  children[0].emit('exit', 1, null)

  assert.match(lines.at(-1), /exit code 1/)
})

test('every error from caffeinate is caught, not just the first', () => {
  const { keepAwake, children } = makeMacKeepAwake()
  keepAwake.acquire('job A')
  const child = children[0]
  child.emit('error', errnoError('spawn /usr/bin/caffeinate EAGAIN', 'EAGAIN'))

  assert.doesNotThrow(() => child.emit('error', errnoError('kill EPERM', 'EPERM')))
})

test('after caffeinate failed, letting go has nothing to stop', () => {
  const { keepAwake, children } = makeMacKeepAwake()
  const release = keepAwake.acquire('job A')
  children[0].emit('error', errnoError('spawn /usr/bin/caffeinate ENOENT', 'ENOENT'))

  release()

  assert.equal(children[0].killCalls, 0)
})

test('a caffeinate that never started is not signalled', () => {
  // Node reports a failed spawn a tick late and gives it no pid; a kill()
  // in between signals pid 0, which is the server's own process group
  const { keepAwake, children, lines } = makeMacKeepAwake({ hasStarted: false })
  const release = keepAwake.acquire('job A')

  release()
  children[0].emit('error', errnoError('spawn /usr/bin/caffeinate ENOENT', 'ENOENT'))

  assert.equal(children[0].killCalls, 0)
  assert.equal(keepAwake.isActive(), false)
  assert.match(lines.at(-1), /ENOENT/)
})

test('a kill that throws is logged, not thrown', () => {
  const { keepAwake, lines } = makeMacKeepAwake({
    onKill: () => {
      throw errnoError('kill EINVAL', 'EINVAL')
    }
  })
  const release = keepAwake.acquire('job A')

  assert.doesNotThrow(release)
  assert.match(lines.at(-1), /EINVAL/)
  assert.equal(keepAwake.isActive(), false)
})

test('a kill that fails with an error event is logged, not thrown', () => {
  // Node's kill() reports EPERM by emitting 'error' on the child, after we
  // have stopped tracking it: that must not crash the server
  const { keepAwake, lines } = makeMacKeepAwake({
    onKill: (child) => {
      child.emit('error', errnoError('kill EPERM', 'EPERM'))
      return false
    }
  })
  const release = keepAwake.acquire('job A')

  assert.doesNotThrow(release)
  assert.ok(lines.some((line) => /EPERM/.test(line)))
})
