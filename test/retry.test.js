const { test } = require('node:test')
const assert = require('node:assert/strict')
const { getEventListeners } = require('node:events')

const { isRetryableDownloadError, withRetries } = require('../retry')

// fail instead of hanging forever if Stop doesn't end a wait
const HANG_GUARD = { timeout: 2000 }

// --- fakes ---

// A failed yt-dlp run, shaped the way server.js's runYtDlp rejects: the
// message and err.stderr both carry what yt-dlp printed
function ytDlpError (stderr) {
  return Object.assign(new Error(stderr.trim()), { stderr, exitCode: 1 })
}

// A failure from Node itself (no yt-dlp output, only a message)
function nodeError (message, code) {
  return Object.assign(new Error(message), { code })
}

// What Node's spawn rejects with when the Stop button kills yt-dlp
function stopError () {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  })
}

const FORBIDDEN = 'ERROR: unable to download video data: HTTP Error 403: Forbidden\n'
const TOO_MANY_REQUESTS = 'ERROR: [youtube] abc123: HTTP Error 429: Too Many Requests\n'
const SERVER_ERROR = 'ERROR: [youtube] abc123: HTTP Error 503: Service Unavailable\n'
const UNAVAILABLE = 'ERROR: [youtube] abc123: Video unavailable. This content isn’t available.\n'

// A song download that fails with each of `failures` in turn, then saves
function flakyDownload (failures) {
  const tries = []
  const task = async (attempt) => {
    tries.push(attempt)
    const failure = failures[tries.length - 1]
    if (failure) throw failure
    return 'saved'
  }
  return { task, tries }
}

// A wait that ends at once, noting how long it was asked to last
function instantSleep () {
  const waits = []
  const sleep = async (ms) => {
    waits.push(ms)
  }
  return { sleep, waits }
}

// A wait that never ends by itself (it ignores Stop, too), plus a promise
// that resolves once the wait has begun
function endlessSleep () {
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const sleep = () => {
    markStarted()
    return new Promise(() => {})
  }
  return { sleep, started }
}

// The error a promise rejects with; fails the test if it resolves instead
async function rejectionOf (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  assert.fail('expected the promise to reject')
}

// Lets every pending promise callback run (the fake clock leaves setImmediate alone)
function settle () {
  return new Promise((resolve) => setImmediate(resolve))
}

// --- trying again ---

test('a download throttled once (HTTP 403) is saved on the second try', async () => {
  const { task, tries } = flakyDownload([ytDlpError(FORBIDDEN)])
  const { sleep, waits } = instantSleep()

  const result = await withRetries(task, { sleep })

  assert.equal(result, 'saved')
  assert.deepEqual(tries, [1, 2])
  assert.deepEqual(waits, [5000])
})

test('after 3 failed tries it gives up with the last error, unchanged', async () => {
  const lastError = ytDlpError(SERVER_ERROR)
  const { task, tries } = flakyDownload([
    ytDlpError(FORBIDDEN),
    ytDlpError(TOO_MANY_REQUESTS),
    lastError
  ])
  const { sleep } = instantSleep()

  const err = await rejectionOf(withRetries(task, { sleep }))

  assert.equal(err, lastError) // the same object, so err.stderr is still there
  assert.equal(err.stderr, SERVER_ERROR)
  assert.deepEqual(tries, [1, 2, 3])
})

test('a failure that cannot succeed (Video unavailable) is not retried', async () => {
  const unavailable = ytDlpError(UNAVAILABLE)
  const { task, tries } = flakyDownload([unavailable])
  const { sleep, waits } = instantSleep()

  const err = await rejectionOf(withRetries(task, { sleep }))

  assert.equal(err, unavailable)
  assert.deepEqual(tries, [1])
  assert.deepEqual(waits, [])
})

test('a download killed by Stop (AbortError) is not retried', async () => {
  const stopped = stopError()
  const { task, tries } = flakyDownload([stopped])
  const { sleep, waits } = instantSleep()

  const err = await rejectionOf(withRetries(task, { sleep }))

  assert.equal(err, stopped)
  assert.deepEqual(tries, [1])
  assert.deepEqual(waits, [])
})

test('onRetry announces tries 2 and 3, each with its wait and the error before it', async () => {
  const failures = [
    ytDlpError(FORBIDDEN),
    ytDlpError(TOO_MANY_REQUESTS),
    ytDlpError(SERVER_ERROR)
  ]
  const { task } = flakyDownload(failures)
  const { sleep } = instantSleep()
  const notices = []

  await rejectionOf(withRetries(task, { sleep, onRetry: (notice) => notices.push(notice) }))

  assert.deepEqual(notices, [
    { attempt: 2, delayMs: 5000, error: failures[0] },
    { attempt: 3, delayMs: 15000, error: failures[1] }
  ])
})

test('a failing onRetry ends the run with its own error (no unhandled rejection)', async () => {
  const { task, tries } = flakyDownload([ytDlpError(FORBIDDEN)])
  const { sleep, waits } = instantSleep()
  const pageUpdateFailed = new Error('could not update the page')

  const err = await rejectionOf(
    withRetries(task, {
      sleep,
      onRetry: async () => {
        throw pageUpdateFailed
      }
    })
  )

  assert.equal(err, pageUpdateFailed)
  assert.deepEqual(tries, [1])
  assert.deepEqual(waits, [])
})

test('with more tries than waits, the last wait is used again', async () => {
  const { task } = flakyDownload([
    ytDlpError(FORBIDDEN),
    ytDlpError(TOO_MANY_REQUESTS),
    ytDlpError(SERVER_ERROR)
  ])
  const { sleep, waits } = instantSleep()

  const result = await withRetries(task, { attempts: 5, delaysMs: [1000, 2000], sleep })

  assert.equal(result, 'saved')
  assert.deepEqual(waits, [1000, 2000, 2000])
})

test('a single attempt means no retry at all', async () => {
  const forbidden = ytDlpError(FORBIDDEN)
  const { task, tries } = flakyDownload([forbidden])
  const { sleep } = instantSleep()

  const err = await rejectionOf(withRetries(task, { attempts: 1, sleep }))

  assert.equal(err, forbidden)
  assert.deepEqual(tries, [1])
})

test('a custom isRetryable decides which failures get another try', async () => {
  const busy = nodeError('resource busy or locked', 'EBUSY')
  const { task, tries } = flakyDownload([busy])
  const { sleep } = instantSleep()

  const result = await withRetries(task, {
    sleep,
    isRetryable: (err) => err.code === 'EBUSY'
  })

  assert.equal(result, 'saved')
  assert.deepEqual(tries, [1, 2])
})

test('mistaken settings are reported before anything runs', async () => {
  const { task, tries } = flakyDownload([])

  await assert.rejects(withRetries(task, { attempts: 0 }), TypeError)
  await assert.rejects(withRetries(task, { attempts: 2.5 }), TypeError)
  await assert.rejects(withRetries(task, { delaysMs: [] }), TypeError)
  await assert.rejects(withRetries(task, { delaysMs: [5000, -1] }), TypeError)
  await assert.rejects(withRetries(task, { onRetry: 'log it' }), TypeError)
  await assert.rejects(withRetries('not a task'), TypeError)
  // server.js keeps the controller as job.abort: its .signal is what's wanted
  await assert.rejects(withRetries(task, { signal: new AbortController() }), /controller\.signal/)
  assert.deepEqual(tries, [])
})

// --- the Stop button ---

test('nothing starts once Stop has been pressed', async () => {
  const controller = new AbortController()
  controller.abort()
  const { task, tries } = flakyDownload([])

  const err = await rejectionOf(withRetries(task, { signal: controller.signal }))

  assert.equal(err, controller.signal.reason)
  assert.equal(err.name, 'AbortError')
  assert.deepEqual(tries, [])
})

test('Stop during the wait gives up at once and starts no more tries', HANG_GUARD, async () => {
  const controller = new AbortController()
  const { task, tries } = flakyDownload([ytDlpError(FORBIDDEN)])
  const { sleep, started } = endlessSleep()

  const run = withRetries(task, { signal: controller.signal, sleep })
  await started
  controller.abort()
  const err = await rejectionOf(run)

  assert.equal(err, controller.signal.reason)
  assert.deepEqual(tries, [1])
})

test('Stop pressed while a try is failing announces no retry', async () => {
  const controller = new AbortController()
  const task = async () => {
    controller.abort() // Stop arrives while this download fails for another reason
    throw ytDlpError(FORBIDDEN)
  }
  const { sleep, waits } = instantSleep()
  const notices = []

  const err = await rejectionOf(
    withRetries(task, {
      signal: controller.signal,
      sleep,
      onRetry: (notice) => notices.push(notice)
    })
  )

  assert.equal(err, controller.signal.reason)
  assert.deepEqual(notices, [])
  assert.deepEqual(waits, [])
})

test('a Stop signal that gives no reason still ends with an AbortError', async () => {
  // a bare signal-like object: aborted, but with no .reason to hand back
  const signal = Object.assign(new EventTarget(), { aborted: true })
  const { task, tries } = flakyDownload([])

  const err = await rejectionOf(withRetries(task, { signal }))

  assert.equal(err.name, 'AbortError')
  assert.deepEqual(tries, [])
})

// --- the real wait, on a fake clock ---

test('the built-in wait holds the next try back for the whole delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { task, tries } = flakyDownload([ytDlpError(FORBIDDEN)])

  const run = withRetries(task)
  await settle()
  t.mock.timers.tick(4999)
  await settle()
  const triesBeforeTheDelay = [...tries]
  t.mock.timers.tick(1)

  assert.equal(await run, 'saved')
  assert.deepEqual(triesBeforeTheDelay, [1])
  assert.deepEqual(tries, [1, 2])
})

test('Stop during the built-in wait ends it at once', HANG_GUARD, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const { task, tries } = flakyDownload([ytDlpError(FORBIDDEN)])

  const run = withRetries(task, { signal: controller.signal })
  await settle()
  controller.abort()
  const err = await rejectionOf(run)

  assert.equal(err, controller.signal.reason)
  assert.deepEqual(tries, [1])
})

test('Stop pressed while onRetry is busy starts no wait at all', HANG_GUARD, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const { task, tries } = flakyDownload([ytDlpError(FORBIDDEN)])

  const err = await rejectionOf(
    withRetries(task, {
      signal: controller.signal,
      onRetry: async () => controller.abort() // Stop lands while the page is told
    })
  )

  assert.equal(err, controller.signal.reason)
  assert.deepEqual(tries, [1])
  // no wait was left listening on the (already stopped) shared signal
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('waits that ran their course leave no listener on the shared Stop signal', async (t) => {
  // every song in a job shares one Stop signal: listeners left behind would pile up
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const { task } = flakyDownload([ytDlpError(FORBIDDEN), ytDlpError(TOO_MANY_REQUESTS)])

  const run = withRetries(task, { signal: controller.signal })
  await settle()
  t.mock.timers.tick(5000)
  await settle()
  t.mock.timers.tick(15000)

  assert.equal(await run, 'saved')
  await settle()
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

// --- which failures are worth another try ---

// Trouble that usually clears up after a short wait, worded the way yt-dlp
// (or Node) words it. Each example holds only its own phrase.
const TEMPORARY = [
  ['HTTP 403 (YouTube throttling)', ytDlpError('ERROR: [youtube] abc123: HTTP Error 403: Forbidden')],
  ['HTTP 429 (too many requests)', ytDlpError('ERROR: [youtube] abc123: HTTP Error 429: Too Many Requests')],
  ['HTTP 500', ytDlpError('ERROR: [youtube] abc123: HTTP Error 500: Internal Server Error')],
  ['HTTP 503', ytDlpError('ERROR: [youtube] abc123: HTTP Error 503: Service Unavailable')],
  ['a timeout', ytDlpError('ERROR: [download] Got error: The read operation timed out')],
  ['a connection reset', ytDlpError('ERROR: [download] Got error: [Errno 54] Connection reset by peer')],
  ['ECONNRESET', nodeError('read ECONNRESET', 'ECONNRESET')],
  ['ETIMEDOUT', nodeError('connect ETIMEDOUT 203.0.113.10:443', 'ETIMEDOUT')],
  ['EAI_AGAIN (DNS)', nodeError('getaddrinfo EAI_AGAIN www.youtube.com', 'EAI_AGAIN')],
  [
    'a temporary DNS failure',
    ytDlpError('ERROR: <urlopen error [Errno -3] Temporary failure in name resolution>')
  ],
  [
    'Unable to download',
    ytDlpError('ERROR: [youtube] abc123: Unable to download webpage: <urlopen error [Errno 61] Connection refused>')
  ],
  ['a missing fragment', ytDlpError('ERROR: fragment 7 not found, unable to continue')],
  [
    'an incomplete read',
    ytDlpError('ERROR: [download] Got error: Connection broken: IncompleteRead(0 bytes read)')
  ],
  [
    // the bundled yt-dlp's wording for the same cut-off read (\r and all)
    'a read cut short (bytes read, more expected)',
    ytDlpError('ERROR: \r[download] Got error: 1045504 bytes read, 2097152 more expected. Giving up after 10 retries')
  ]
]

for (const [what, err] of TEMPORARY) {
  test(`tried again: ${what}`, () => {
    assert.equal(isRetryableDownloadError(err), true)
  })
}

// yt-dlp often warns about throttling on its way to the real error, so every
// final reason below comes after such a warning: the final reason must win
const THROTTLE_WARNING =
  'WARNING: [youtube] abc123: HTTP Error 429: Too Many Requests. Retrying (1/3)...\n'

function finalAfterThrottling (finalLine) {
  return ytDlpError(`${THROTTLE_WARNING}ERROR: [youtube] abc123: ${finalLine}\n`)
}

// Failures that no amount of trying again fixes (or, for the bot check,
// that trying again makes worse)
const PERMANENT = [
  ['Video unavailable', finalAfterThrottling('Video unavailable. This content isn’t available.')],
  [
    'Private video',
    finalAfterThrottling("Private video. Sign in if you've been granted access to this video")
  ],
  [
    'age-restricted',
    finalAfterThrottling('Sign in to confirm your age. This video may be inappropriate for some users.')
  ],
  ['This video is not available', finalAfterThrottling('This video is not available')],
  [
    'a copyright block',
    finalAfterThrottling('This video contains content from SomeLabel, who has blocked it on copyright grounds')
  ],
  ['removed', finalAfterThrottling('This video has been removed by the uploader')],
  [
    'members-only',
    finalAfterThrottling('Join this channel to get access to members-only content like this video, and other exclusive perks.')
  ],
  ['no MP3 produced', finalAfterThrottling('no MP3 produced')],
  [
    "YouTube's bot check (curly apostrophe, as YouTube sends it)",
    finalAfterThrottling('Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.')
  ],
  ["YouTube's bot check (straight apostrophe)", finalAfterThrottling("Sign in to confirm you're not a bot")],
  ['Stop (AbortError)', Object.assign(stopError(), { stderr: THROTTLE_WARNING })]
]

for (const [what, err] of PERMANENT) {
  test(`not tried again: ${what}`, () => {
    assert.equal(isRetryableDownloadError(err), false)
  })
}

test('the stderr is read when the message only gives an exit code', () => {
  const err = Object.assign(new Error('yt-dlp exited with code 1'), { stderr: FORBIDDEN })

  assert.equal(isRetryableDownloadError(err), true)
})

test('an error it does not recognise is not tried again', () => {
  assert.equal(isRetryableDownloadError(new Error('ffmpeg exited with code 1')), false)
})

test('no error at all is not tried again', () => {
  assert.equal(isRetryableDownloadError(undefined), false)
  assert.equal(isRetryableDownloadError(null), false)
})
