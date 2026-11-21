// Trying a failed song download again, a couple of times, when the failure
// looks temporary (YouTube throttling, a network hiccup), but not when it
// can't succeed (the video is gone, private, age-restricted...), when YouTube
// suspects a bot, or when Stop was pressed.
//
// server.js wraps each song's yt-dlp download in withRetries:
//
//   const { withRetries } = require('./retry')
//
//   await withRetries(
//     () => services.downloadMP3(video.url, outputTemplate, userQuality, {
//       signal: job.abort.signal, ...
//     }),
//     {
//       signal: job.abort.signal,
//       onRetry: ({ attempt, delayMs, error }) => { ... } // "retrying in 5 s"
//     }
//   )
//
// isRetryableDownloadError(err) -> boolean
//   Reads err.stderr || err.message (runYtDlp's errors carry yt-dlp's stderr).
//   true: HTTP 403 / 429 / 5xx, timeouts, connection resets, ECONNRESET,
//   ETIMEDOUT, EAI_AGAIN, temporary DNS failures, "Unable to download",
//   missing fragments, reads cut off part-way ("Got error: ... incomplete").
//   false: unavailable / private / age-restricted / removed / members-only
//   videos, copyright blocks, "no MP3 produced", YouTube's bot check, an
//   AbortError (Stop), and anything it doesn't recognise.
//
// withRetries(task, options) -> Promise of what task resolves with
//   Calls task(attempt) for attempt 1, 2, 3... When a try fails with an error
//   isRetryable accepts and tries are left, it awaits
//   onRetry({ attempt, delayMs, error }) (attempt: the try about to start;
//   error: the one that just failed), waits delayMs, then tries again.
//   Otherwise it rejects with the last error itself: the same object, so
//   err.stderr is still there.
//   options, all optional:
//     attempts = 3              tries in all, the first one included
//     delaysMs = [5000, 15000]  wait before the 2nd try, the 3rd...; the last
//                               one repeats for any later tries
//     isRetryable = isRetryableDownloadError
//     signal                    the job's Stop signal (an AbortSignal).
//                               Nothing starts once it has aborted, and Stop
//                               during a wait rejects at once with
//                               signal.reason (an AbortError by default);
//                               no retry is announced after Stop
//     onRetry = () => {}        may be async; if it throws or rejects, the
//                               run ends with that error
//     sleep = (ms, signal) => Promise   the wait itself (tests pass a fake);
//                               Stop ends the wait even if sleep ignores it
//   Bad options (attempts not a whole number from 1 up, delaysMs empty or
//   negative, task or a callback not a function, an AbortController passed
//   as signal instead of its .signal) reject with a TypeError before the
//   first try.
//
// DEFAULT_ATTEMPTS (3) and DEFAULT_DELAYS_MS ([5000, 15000], frozen) are
// exported too, e.g. for the page to say "try 2 of 3".

const { inspect } = require('node:util')

// Three tries in all. The first wait lets a burst of throttling pass; the
// longer second one gives YouTube (or the Wi-Fi) a real chance to recover.
const DEFAULT_ATTEMPTS = 3
const DEFAULT_DELAYS_MS = Object.freeze([5000, 15000])

// Failures that no amount of trying again fixes. They are checked first,
// because yt-dlp often prints a throttling warning (HTTP 429...) on its way
// to one of these.
const PERMANENT_FAILURES = [
  /video unavailable/i,
  /private video/i,
  /sign in to confirm your age/i,
  /this video is not available/i,
  /copyright/i,
  /has been removed/i,
  /members-only/i,
  // yt-dlp reported success yet left no MP3: the same run would do the same
  /no MP3 produced/i,
  // YouTube's bot check ("Sign in to confirm you’re not a bot"): asking
  // again soon only makes it stricter
  /not a bot/i
]

// Failures that usually clear up after a short wait
const TEMPORARY_FAILURES = [
  // YouTube throttling (403 / 429) or its servers having a moment (5xx)
  /HTTP Error (?:403|429|5\d\d)\b/i,
  /timed out/i,
  /connection reset/i,
  // Node's names for a reset connection, a timeout, a failed DNS lookup
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN/,
  // "Temporary failure in name resolution": a DNS hiccup
  /temporary failure/i,
  /unable to download/i,
  // a piece of the stream went missing mid-download
  /fragment/i,
  // a read cut off part-way: older yt-dlp says "IncompleteRead(...)", the
  // bundled one "1045504 bytes read, 2097152 more expected"
  /got error:.*(?:incomplete|more expected)/i
]

function isRetryableDownloadError (err) {
  if (err == null || err.name === 'AbortError') return false
  const output = String(err.stderr || err.message || err)
  if (PERMANENT_FAILURES.some((pattern) => pattern.test(output))) return false
  return TEMPORARY_FAILURES.some((pattern) => pattern.test(output))
}

async function withRetries (
  task,
  {
    attempts = DEFAULT_ATTEMPTS,
    delaysMs = DEFAULT_DELAYS_MS,
    isRetryable = isRetryableDownloadError,
    signal,
    onRetry = () => {},
    sleep = sleepUnlessStopped
  } = {}
) {
  checkRetryOptions({ task, attempts, delaysMs, isRetryable, onRetry, sleep, signal })

  for (let attempt = 1; ; attempt++) {
    throwIfStopped(signal)
    try {
      return await task(attempt)
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error
      // Stop pressed while this try was failing: no retry is coming, so
      // don't announce one
      throwIfStopped(signal)
      const nextAttempt = attempt + 1
      const delayMs = delayBefore(nextAttempt, delaysMs)
      await onRetry({ attempt: nextAttempt, delayMs, error })
      await waitUnlessStopped(sleep(delayMs, signal), signal)
    }
  }
}

// The wait before try number `attempt` (2, 3...): delaysMs[0] before the
// 2nd, delaysMs[1] before the 3rd, and the last one again after that
function delayBefore (attempt, delaysMs) {
  return delaysMs[Math.min(attempt - 2, delaysMs.length - 1)]
}

// What a stopped run rejects with: whatever abort() was given (an
// AbortError when nothing was), or an AbortError if the signal has no reason
function stopReason (signal) {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function throwIfStopped (signal) {
  if (signal?.aborted) throw stopReason(signal)
}

// Settles like `wait`, except that Stop rejects at once with the stop reason,
// whether or not the wait itself listens to the signal (a test's fake may not)
function waitUnlessStopped (wait, signal) {
  if (!signal) return wait
  return new Promise((resolve, reject) => {
    const stop = () => reject(stopReason(signal))
    // the job's Stop signal is shared by every song: don't leave a listener on it
    Promise.resolve(wait)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
}

// The default wait: `ms` on a timer. Stop clears the timer and rejects, so a
// stopped job leaves nothing ticking; a wait that runs its course takes its
// listener off the shared Stop signal.
function sleepUnlessStopped (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(stopReason(signal))
      return
    }
    const stop = () => {
      clearTimeout(timer)
      reject(stopReason(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}

// Setup mistakes surface before the first try, not halfway through a job
function checkRetryOptions ({ task, attempts, delaysMs, isRetryable, onRetry, sleep, signal }) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(`attempts must be a whole number, 1 or more (got ${inspect(attempts)})`)
  }
  const isDelayList =
    Array.isArray(delaysMs) &&
    delaysMs.length > 0 &&
    delaysMs.every((ms) => Number.isFinite(ms) && ms >= 0)
  if (!isDelayList) {
    throw new TypeError(
      `delaysMs must be a non-empty list of waits in ms, each 0 or more (got ${inspect(delaysMs)})`
    )
  }
  const callbacks = { task, isRetryable, onRetry, sleep }
  const notFunctions = Object.keys(callbacks).filter((name) => typeof callbacks[name] !== 'function')
  if (notFunctions.length > 0) {
    throw new TypeError(`${notFunctions.join(', ')} must be a function`)
  }
  // an AbortController passed by mistake would only fail at the first wait
  if (signal != null && typeof signal.addEventListener !== 'function') {
    throw new TypeError(
      `signal must be an AbortSignal: pass controller.signal, not the controller (got ${inspect(signal)})`
    )
  }
}

module.exports = {
  DEFAULT_ATTEMPTS,
  DEFAULT_DELAYS_MS,
  isRetryableDownloadError,
  withRetries
}
