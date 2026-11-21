// ZipifyTunes page: runs one or more playlist CSVs (a batch) one after
// another and shows live progress for the playlist being downloaded. Songs a
// run couldn't match for sure land in a review list, where the right YouTube
// upload can be picked and downloaded.

const POLL_MS = 1000;

// songs downloaded at once: the server takes 1–20 and uses 3 for anything else
const DEFAULT_PARALLEL = 3;
const MAX_PARALLEL = 20;

// what the server's review endpoints accept (/picks, /alternatives)
const MAX_PICKS_PER_JOB = 1000;
const MAX_SEARCH_TEXT = 300;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const JSON_HEADERS = { "Content-Type": "application/json" };

// the live run panel: the countdown ticks between polls, just after each
// whole second of the time left, and a change to how many download at once
// waits this long for the person to settle on a number (and gives up on an
// answer after PARALLEL_TIMEOUT_MS, so the control never sticks)
const COUNTDOWN_TICK_MS = 1000;
const COUNTDOWN_TICK_LATE_MS = 20;
const PARALLEL_DEBOUNCE_MS = 300;
const PARALLEL_TIMEOUT_MS = 10_000;

// A new estimate less than ETA_SNAP_SHARE away from the time shown moves the
// countdown ETA_EASE_SHARE of the way to it each poll; one further off is a
// real change (more at once, the pace after a pause) and is shown at once.
// While it eases, the countdown runs at ETA_SLOWEST_PACE to ETA_FASTEST_PACE
// seconds a second: it never stalls, counts up or races off.
const ETA_SNAP_SHARE = 0.25;
const ETA_EASE_SHARE = 0.15;
const ETA_SLOWEST_PACE = 0.5;
const ETA_FASTEST_PACE = 4;

// what a "Recently finished" row's chip says for each outcome
const OUTCOME_CHIPS = {
  saved: "✓ saved",
  reused: "↺ reused",
  skipped: "↷ skipped",
  review: "? review",
  failed: "✗ failed",
};

const PHASE_LABELS = {
  searching: "Searching YouTube…",
  downloading: "Downloading…",
  converting: "Converting to MP3…",
  tagging: "Adding cover art and tags…",
};

// tries in all for a failed download, when the server retries it ("attempt 2 of 3")
const RETRY_ATTEMPTS = 3;

const STATUS_LABELS = {
  waiting: "Waiting",
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const $ = (id) => document.getElementById(id);
const Charts = window.ZipifyCharts; // charts.js, loaded just before this file

let batch = []; // every run listed in the batch panel, see batchEntry()
let isBatchRunning = false;
let isBatchStopped = false; // Stop also cancels the playlists still waiting
let activeJob = null; // { id, control } of the playlist downloading now
let lastEventSeq = 0; // last ✓ / ✗ / ↷ / ? line already shown

// Songs waiting for someone to pick the right upload: { key, playlist:
// { name, saveFolder, trackTotal }, song, reason, candidates, chosenId,
// isSelected, isSearching }. A change replaces the entry rather than editing
// it, and goes through setReviewItems, which keeps the list on this browser.
let reviewItems = [];
let lastReviewKey = 0; // keys only ever count up, so each one is unique

// The rows of the songs being worked on, by song number (see renderActiveSongs)
let activeSongRows = new Map();

// The Songs done chart's time axis: where it ended for which run, so it only
// moves in steps (see Charts.progressChart)
let progressAxis = { jobId: null, spanMs: null };

// The time-left countdown (see nextCountdown) and the timer that ticks it
// each second while a run goes.
let liveCountdown = null;
let countdownTimer = null;

// when each song waiting to retry tries again, see retryDeadlines
let retryDeadlinesBySong = new Map();

// Downloading at once, changed mid-run: the limit the server last confirmed,
// the person's choice until the server has it (null once settled), the
// debounce timer, whether a change is on its way (one at a time), how many
// changes have been answered (a poll sent before the latest answer is out
// of date, see isPollParallelFresh), whether the control can be used, and
// the songs running at the last poll.
let serverParallel = DEFAULT_PARALLEL;
let pendingParallel = null;
let parallelTimer = null;
let isSendingParallel = false;
let parallelAnswers = 0;
let isParallelEnabled = false;
let lastActiveCount = 0;

// The run the Live stats card shows, the recent songs it lists, and the
// charts being read right now (see watchChartReading).
let statsJob = null;
let shownRecentKey = "";
const chartsBeingRead = new Set();

// --- small helpers ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  if (bytes >= 10 * 1024 ** 2) return Math.round(bytes / 1024 ** 2) + " MB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min} min ${totalSec % 60} s`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// a video's length the way YouTube shows it: 245 -> "4:05"
function formatClock(seconds) {
  const totalSec = Math.round(seconds);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

function playlistName(fileName) {
  return fileName.replace(/\.csv$/i, "");
}

// How many songs were saved / skipped / listed for review / failed so far.
// Songs listed for review can still be picked and downloaded, so they don't
// count as failed. Reused songs (copied from another playlist's folder)
// count as saved too; an older server sends no reusedCount.
function countsOf(job) {
  const saved = job.savedCount ?? job.downloaded ?? 0;
  const reused = Number.isFinite(job.reusedCount) ? Math.min(saved, Math.max(0, job.reusedCount)) : 0;
  const skipped = job.skippedCount ?? 0;
  const toReview = job.reviewCount ?? 0;
  const failed = Math.max(0, job.done - saved - skipped - toReview);
  return { saved, reused, skipped, toReview, failed };
}

function countsText(job) {
  const { saved, reused, skipped, toReview, failed } = countsOf(job);
  return [
    reused ? `${saved} saved (${reused} reused)` : `${saved} saved`,
    skipped ? `${skipped} skipped` : "",
    toReview ? `${toReview} to review` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// --- status log (colored by how a line starts: ✓ ✗ ↷ ↺ ?) ---

function lineKind(text) {
  if (text.startsWith("✓")) return "ok";
  if (text.startsWith("✗")) return "fail";
  if (text.startsWith("↷")) return "skip";
  if (text.startsWith("↺")) return "reused";
  if (text.startsWith("? ")) return "review";
  return "";
}

function log(text, kind = lineKind(text)) {
  const box = $("statusBox");
  box.append(el("div", `log-line ${kind}`.trim(), text));
  box.scrollTop = box.scrollHeight;
}

// --- save folder: drive suggestions and the system folder dialog ---

// Runs on load and whenever the field gets focus, so a pen drive plugged in
// later still shows up.
async function loadDrives() {
  let drives;
  try {
    const res = await fetch("/drives");
    drives = res.ok ? await res.json() : [];
  } catch (e) {
    return; // keep whatever was listed; a typed path still works
  }

  $("driveList").replaceChildren(
    ...drives.map((d) => {
      const option = document.createElement("option");
      option.value = d.path;
      option.label = `${d.name} — ${formatBytes(d.freeBytes)} free`;
      return option;
    })
  );
}

// The server opens the system's folder dialog and answers once the person
// picks a folder or cancels.
async function chooseFolder() {
  const button = $("chooseFolder");
  button.disabled = true;
  button.textContent = "Choosing…";

  try {
    const res = await fetch("/pick-folder", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log(body.error || "Could not open the folder picker.", "warn");
      return;
    }
    if (body.path) $("saveTo").value = body.path;
  } catch (e) {
    log("Could not reach the server. Is it running?", "fail");
  } finally {
    button.disabled = false;
    button.textContent = "Choose…";
  }
}

// --- the run panel (the playlist downloading now) ---

function setProgressState(state) {
  $("progress").dataset.state = state;
}

function renderProgress(job) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  $("progressBar").style.transform = `scaleX(${pct / 100})`;
  $("progress").setAttribute("aria-valuenow", String(pct));
  $("progressText").textContent = job.total
    ? `${job.done} / ${job.total} songs (${pct}%)`
    : "Waiting…";
}

// A song waiting to retry: when its next try starts, by song number and
// attempt. A later poll of the same wait keeps the earlier time, so the wait
// counts down whether the server sends the time left or the whole wait.
function retryDeadlines(songs, previous, now) {
  const next = new Map();
  for (const song of songs) {
    if (song.phase !== "retrying" || !Number.isFinite(song.retryInMs)) continue;
    const key = `${song.number}:${song.attempt}`;
    const at = now + Math.max(0, song.retryInMs);
    next.set(key, Math.min(previous.get(key) ?? at, at));
  }
  return next;
}

// "Retrying (attempt 2 of 3) in 5s…"; whatever the server leaves out is left out
function retryText(song, now) {
  const attempt = Number.isInteger(song.attempt)
    ? ` (attempt ${song.attempt} of ${Math.max(RETRY_ATTEMPTS, song.attempt)})`
    : "";
  const at = retryDeadlinesBySong.get(`${song.number}:${song.attempt}`);
  const seconds = at == null ? 0 : Math.ceil((at - now) / 1000);
  return `Retrying${attempt}${seconds > 0 ? ` in ${seconds}s` : ""}…`;
}

function describeSong(song, now = Date.now()) {
  if (song.phase === "retrying") return retryText(song, now);
  if (song.phase === "downloading" && song.totalBytes) {
    const pct = Math.round((song.downloadedBytes / song.totalBytes) * 100);
    const speed = song.speedBps ? ` · ${formatBytes(song.speedBps)}/s` : "";
    return (
      `Downloading ${formatBytes(song.downloadedBytes)} of ` +
      `${formatBytes(song.totalBytes)} (${pct}%)${speed}`
    );
  }
  return PHASE_LABELS[song.phase] || song.phase;
}

// how full the song's little bar is: the download, then full while converting
function songFraction(song) {
  if (song.phase === "downloading" && song.totalBytes) {
    return Math.min(1, song.downloadedBytes / song.totalBytes);
  }
  return song.phase === "converting" || song.phase === "tagging" ? 1 : 0;
}

// One row per song being worked on. A song keeps its row from poll to poll
// (by song number), and only what changed in it is written: the list isn't
// rebuilt every second, so nothing flickers, text being selected stays
// selected, and the bars glide. Finished songs are announced by the status
// log, so the list itself isn't a live region.
function renderActiveSongs(job) {
  // an older server reports one `current` song instead of `active`
  const songs = job.active ?? (job.current ? [job.current] : []);
  const now = Date.now();
  retryDeadlinesBySong = retryDeadlines(songs, retryDeadlinesBySong, now);

  const rows = new Map(songs.map((song) => [song.number, activeSongRows.get(song.number) ?? activeSongRow()]));
  for (const song of songs) showActiveSong(rows.get(song.number), song, now);
  activeSongRows = rows;
  const nodes = [...rows.values()].map((row) => row.node);
  const list = $("activeSongs");
  if (!hasChildren(list, nodes)) list.replaceChildren(...nodes);
}

function activeSongRow() {
  const node = el("li", "song");
  const title = el("div", "song-title");
  const detail = el("div", "song-detail");
  const bar = el("div", "song-bar");
  const fill = el("span");
  bar.append(fill);
  node.append(title, detail, bar);
  return { node, title, detail, fill };
}

function showActiveSong(row, song, now) {
  if (row.node.dataset.phase !== song.phase) row.node.dataset.phase = song.phase;
  setText(row.title, `${song.number}. ${song.title} — ${song.artist}`);
  setText(row.detail, describeSong(song, now));
  row.fill.style.transform = `scaleX(${songFraction(song)})`;
}

// text is only replaced when it changed
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// whether `list` holds exactly `nodes`, in that order
function hasChildren(list, nodes) {
  const children = list.children;
  return children.length === nodes.length && nodes.every((node, i) => children[i] === node);
}

function countBadge(n, label, kind) {
  return el("span", `count ${kind}`, `${n} ${label}`);
}

function renderStats(job) {
  const { saved, skipped, toReview, failed } = countsOf(job);
  const parts = [countBadge(saved, "saved", "ok")];
  if (skipped) parts.push(" · ", countBadge(skipped, "skipped", "skip"));
  if (toReview) parts.push(" · ", countBadge(toReview, "to review", "review"));
  if (failed) parts.push(" · ", countBadge(failed, "failed", "fail"));
  $("statCounts").replaceChildren(...parts);

  const savedBytes = job.savedBytes ?? 0;
  $("statSize").textContent =
    formatBytes(savedBytes) +
    (job.estimatedTotalBytes ? ` of about ${formatBytes(job.estimatedTotalBytes)}` : "");

  // the time left is the countdown's job now; two estimates would disagree
  $("statTime").textContent = `${formatDuration(job.elapsedMs ?? 0)} so far`;
}

function renderControls(job) {
  const isPaused = job.control === "pause";
  const isStopping = job.control === "stop";
  $("pauseButton").textContent = isPaused ? "Resume" : "Pause";
  $("pauseButton").disabled = isStopping;
  $("stopButton").disabled = isStopping;

  let state = "running";
  if (isStopping) state = "stopping";
  else if (isPaused) state = "paused";
  setProgressState(state);
}

// "☾ Keeping your Mac awake" while the server says it is (an older server never does)
function renderAwake(job) {
  $("awakeBadge").classList.toggle("hidden", job.keepingAwake !== true);
}

// The run panel from a /progress snapshot (or an answer that shows the run
// the same way). answersAtPoll: the changes to how many download at once
// answered when the snapshot was asked for (see renderParallel).
function renderJob(job, answersAtPoll = parallelAnswers) {
  renderProgress(job);
  renderActiveSongs(job);
  renderStats(job);
  renderControls(job);
  renderAwake(job);
  syncCountdown(job);
  renderParallel(job, answersAtPoll);
}

function resetRunPanel(name, parallel) {
  $("runPanel").classList.remove("hidden");
  $("runName").textContent = name;
  startCountdown();
  startParallelControl(parallel);
  renderJob({ done: 0, total: 0, control: "run", active: [], savedBytes: 0, elapsedMs: 0, etaMs: null, parallel });
  $("statCounts").textContent = "—";
  $("statSize").textContent = "—";
  $("statTime").textContent = "—";
}

// hasSaved: whether the run saved any song (a stopped run says so)
function endRunPanel(state, hasSaved = true) {
  setProgressState(state);
  $("activeSongs").replaceChildren();
  activeSongRows = new Map();
  retryDeadlinesBySong = new Map();
  $("awakeBadge").classList.add("hidden");
  $("pauseButton").disabled = true;
  $("stopButton").disabled = true;
  endCountdown(state, hasSaved);
  endParallelControl();
}

// --- the countdown (time left) ---

// What the countdown counts down from, after a poll at `now`:
// { remainingMs: the time left shown (null until there's an estimate),
//   targetMs: what the time shown is heading for, as of `at`,
//   sinceFinishMs: how long the run has gone since a song last finished,
//   at, control: run | pause | stop, done, parallel: the run's as of this poll }.
// The server's estimate is about the time between two finished songs, times
// the songs left. It's news when something it's worked out from changed (a
// song finished, the limit, a pause or resume), and news is eased in (see
// easedRemainingMs). Between two finished songs the estimate holds still,
// or creeps up while songs run late: the run is that far into its next
// song, so the target is the estimate less the time since a song last
// finished, up to one song's time (see songTimeMs). While the pace holds,
// that runs down with the countdown; when songs run late it follows the
// estimate up, eased in and never snapped to, so the countdown slows down
// rather than hops. Paused, the time shown stays put. No estimate (yet):
// whatever is shown keeps running down.
function nextCountdown(previous, job, now) {
  const control = job.control ?? "run";
  const shownMs = previous ? runDown(previous.remainingMs, previous, now) : null;
  // only time the run spent going counts (none across a pause)
  const ranMs = previous?.control === "run" ? now - previous.at : 0;
  const hasFinished = previous == null || job.done !== previous.done;
  const sinceFinishMs = hasFinished ? 0 : previous.sinceFinishMs + ranMs;
  const next = { at: now, control, done: job.done, parallel: job.parallel, sinceFinishMs };
  const serverMs = Number.isFinite(job.etaMs) ? Math.max(0, job.etaMs) : null;
  if (serverMs == null) {
    const targetMs = previous ? runDown(previous.targetMs, previous, now) : null;
    return { ...next, remainingMs: shownMs, targetMs };
  }

  const isNews = previous?.targetMs == null || hasRunChanged(previous, next);
  const intoNextSongMs = Math.min(sinceFinishMs, songTimeMs(serverMs, job));
  const targetMs = isNews ? serverMs : Math.max(0, serverMs - intoNextSongMs);
  const isFrozen = control !== "run" && shownMs != null;
  const remainingMs = isFrozen ? shownMs : easedRemainingMs(shownMs, targetMs, ranMs, isNews);
  return { ...next, remainingMs, targetMs };
}

// a song finished, the limit changed, or the run was paused or resumed
function hasRunChanged(previous, next) {
  return previous.done !== next.done || previous.parallel !== next.parallel || previous.control !== next.control;
}

// One song's time at the server's pace: its estimate over the songs left.
// None once every song left is under way: the estimate then counts down by
// itself (the run ends when the slowest of them does). An older server
// sends no total, and then there's no telling (no limit).
function songTimeMs(serverMs, job) {
  const left = job.total - job.done;
  if (left <= activeCountOf(job)) return 0;
  return left > 0 ? serverMs / left : Infinity;
}

// The time left to show once a poll brings `targetMs`, `ranMs` after the
// last one: the first estimate, or news a quarter or more away from the
// time shown (a real change), is shown as it is (canSnap: whether the
// target is news); otherwise the time shown moves part of the way, at a
// pace that keeps the countdown going down (see ETA_SLOWEST_PACE and
// ETA_FASTEST_PACE).
function easedRemainingMs(shownMs, targetMs, ranMs, canSnap = true) {
  if (shownMs == null) return targetMs;
  const gapMs = targetMs - shownMs;
  if (canSnap && Math.abs(gapMs) >= ETA_SNAP_SHARE * shownMs) return targetMs;
  const mostBackMs = (1 - ETA_SLOWEST_PACE) * ranMs;
  const mostAheadMs = (ETA_FASTEST_PACE - 1) * ranMs;
  return shownMs + Math.min(mostBackMs, Math.max(-mostAheadMs, ETA_EASE_SHARE * gapMs));
}

// a time left `ms` (right at countdown.at) as of `now`: it only runs down
// while the run is going, and never below 0
function runDown(ms, countdown, now) {
  if (ms == null) return null;
  if (countdown.control !== "run") return ms;
  return Math.max(0, ms - (now - countdown.at));
}

// the time left shown at `now`
function remainingAt(countdown, now) {
  return countdown ? runDown(countdown.remainingMs, countdown, now) : null;
}

// part of a second still to go reads as 0:01, never as 0:00
function countdownClock(ms) {
  return Charts.formatClockMs(Math.ceil(ms / 1000) * 1000);
}

// "1:47 AM" (as this computer writes times); "1:47 AM tomorrow" past
// midnight; with the weekday ("Sat 1:47 AM") when it's further off
function timeOfDay(ms, now) {
  const when = new Date(ms);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (when.toDateString() === today.toDateString()) return time;
  if (when.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

// What the countdown shows: { state, value, note, isTime }
function countdownView(countdown, now) {
  const control = countdown?.control ?? "run";
  const remainingMs = remainingAt(countdown, now);
  if (control === "stop") {
    // Stop cancels the downloads under way; only songs already being tagged still land
    return { state: "stopping", value: "Stopping…", note: "downloads in progress are cancelled; saved songs stay", isTime: false };
  }
  if (control === "pause") {
    return remainingMs == null
      ? { state: "paused", value: "Paused", note: "", isTime: false }
      : { state: "paused", value: countdownClock(remainingMs), note: "paused", isTime: true };
  }
  if (remainingMs == null) {
    return { state: "pending", value: "Working out…", note: "once a few songs are done", isTime: false };
  }
  const note = remainingMs > 0 ? `done around ${timeOfDay(now + remainingMs, now)}` : "any moment now";
  return { state: "running", value: countdownClock(remainingMs), note, isTime: true };
}

// what the countdown shows once the run is over (endRunPanel's states);
// hasSaved: whether the run saved any song
function finalCountdownView(state, now, hasSaved = true) {
  if (state === "done") {
    return { state, value: "Done", note: `finished at ${timeOfDay(now, now)}`, isTime: false };
  }
  if (state === "stopped") {
    const note = hasSaved ? "songs already saved are kept" : "nothing was saved";
    return { state, value: "Stopped", note, isTime: false };
  }
  return { state: "failed", value: "—", note: "the run didn't finish", isTime: false };
}

function showCountdown({ state, value, note, isTime }) {
  $("countdown").dataset.state = state;
  $("countdownValue").textContent = value;
  $("countdownValue").dataset.kind = isTime ? "time" : "text";
  $("countdownNote").textContent = note;
}

function renderCountdown() {
  showCountdown(countdownView(liveCountdown, Date.now()));
}

// How long until the time shown reaches its next whole second: the countdown
// ticks just after it, so every second is on screen for a whole second (a
// plain one-second timer drifts against the polls and skips or doubles
// seconds). Once a second while nothing runs down (paused, no estimate yet).
function countdownTickDelay(countdown, now) {
  const remainingMs = remainingAt(countdown, now);
  if (countdown?.control !== "run" || !(remainingMs > 0)) return COUNTDOWN_TICK_MS;
  return (remainingMs % COUNTDOWN_TICK_MS || COUNTDOWN_TICK_MS) + COUNTDOWN_TICK_LATE_MS;
}

function scheduleCountdownTick() {
  clearTimeout(countdownTimer);
  countdownTimer = setTimeout(tickCountdown, countdownTickDelay(liveCountdown, Date.now()));
}

function tickCountdown() {
  renderCountdown();
  scheduleCountdownTick();
}

// a fresh countdown for a run that's starting, ticking each second
function startCountdown() {
  stopCountdown();
  liveCountdown = null;
  scheduleCountdownTick();
}

function stopCountdown() {
  clearTimeout(countdownTimer);
  countdownTimer = null;
}

// A poll's (or an answer's) estimate, as of when it arrived. Easing it in
// moves where the next second falls, so the tick is set again (unless the
// run is over and the countdown has stopped).
function syncCountdown(job) {
  liveCountdown = nextCountdown(liveCountdown, job, Date.now());
  renderCountdown();
  if (countdownTimer != null) scheduleCountdownTick();
}

// what's left of a run's countdown is cleared, so nothing of it carries into the next
function endCountdown(state, hasSaved) {
  stopCountdown();
  liveCountdown = null;
  showCountdown(finalCountdownView(state, Date.now(), hasSaved));
}

// --- downloading at once, changed while a run goes ---

// "6 songs in progress": songs being searched for, downloaded, converted or
// tagged (only a few of them download at any moment). After lowering the
// limit below that: "6 songs in progress · finishing 3 first, then 3 at
// once": songs already going aren't cut off, and no new one starts until
// fewer than the limit are. canStartMore: false while the run stops or once
// it's over, when nothing new starts at all.
function runningNowText(activeCount, parallel, canStartMore = true) {
  const songs = activeCount === 1 ? "1 song in progress" : `${activeCount} songs in progress`;
  if (!canStartMore || activeCount <= parallel) return songs;
  return `${songs} · finishing ${activeCount - parallel} first, then ${parallel} at once`;
}

// what the slider reads out: "1 song at a time", "5 songs at once"
function parallelValueText(parallel) {
  return parallel === 1 ? "1 song at a time" : `${parallel} songs at once`;
}

// A poll's "parallel" is the limit the server had when it answered: out of
// date while a change is on its way, or when one was answered after the poll
// was sent (answers: changes answered so far; answersAtPoll: as it was sent).
function isPollParallelFresh({ isSending, answersAtPoll, answers }) {
  return !isSending && answersAtPoll === answers;
}

// The number to send once the person has settled on one. Nothing while
// another change is on its way: theirs goes once that one is answered, so
// the server can't take two out of order. Nothing when the server has it.
function parallelToSend({ pending, server, isSending }) {
  if (pending == null || isSending || pending === server) return null;
  return pending;
}

// once a change is answered (taken or refused) the choice is settled, unless
// another number was picked meanwhile: that one is still to go
function pendingAfterAnswer(pending, sent) {
  return pending === sent ? null : pending;
}

// only a run that's going (paused counts) and isn't stopping can change it
function canChangeParallel(job, isActive = activeJob != null) {
  return isActive && job.status === "running" && job.control !== "stop";
}

// songs being worked on now; an older server only lists them
function activeCountOf(job) {
  if (Number.isInteger(job.activeCount)) return job.activeCount;
  return (job.active ?? (job.current ? [job.current] : [])).length;
}

// the person's choice until the server has it, then the server's limit
function shownParallel() {
  return pendingParallel ?? serverParallel;
}

// The number, the − / + buttons and the slider all show `parallel`. Each is
// only touched when it changes: rewriting the slider would cut into a drag,
// and the number is a live region that would be read out on every poll.
// − is off at 1 and + at MAX_PARALLEL, where they couldn't do anything.
function renderParallelControl(parallel, isEnabled) {
  const text = String(parallel);
  const slider = $("parallelSlider");
  if (slider.value !== text) slider.value = text;
  slider.setAttribute("aria-valuetext", parallelValueText(parallel));
  slider.disabled = !isEnabled;
  setStepperButton($("parallelDown"), !isEnabled || parallel <= 1);
  setStepperButton($("parallelUp"), !isEnabled || parallel >= MAX_PARALLEL);
  if ($("parallelValue").textContent !== text) $("parallelValue").textContent = text;
}

// A button switched off under keyboard focus would drop the focus to the
// page: it goes to the slider beside it instead.
function setStepperButton(button, isDisabled) {
  const slider = $("parallelSlider");
  if (isDisabled && document.activeElement === button && !slider.disabled) slider.focus();
  button.disabled = isDisabled;
}

function showParallel() {
  const parallel = shownParallel();
  renderParallelControl(parallel, isParallelEnabled);
  $("parallelRunning").textContent = runningNowText(lastActiveCount, parallel, isParallelEnabled);
}

// The control from a /progress snapshot. The person's choice stays up until
// the server has it, and a snapshot asked for before the latest change was
// answered can't say what the server has now (see isPollParallelFresh).
// Once the run stops (from the Stop click on, before the server has it) or
// is over, a change not sent yet is dropped.
function renderParallel(job, answersAtPoll) {
  const isFresh = isPollParallelFresh({ isSending: isSendingParallel, answersAtPoll, answers: parallelAnswers });
  if (isFresh && Number.isInteger(job.parallel)) serverParallel = job.parallel;
  isParallelEnabled = canChangeParallel(job) && !isBatchStopped;
  lastActiveCount = activeCountOf(job);
  if (!isParallelEnabled) dropParallelChange();
  showParallel();
}

// A run that's starting uses `parallel` (the setup form's number). The
// control works once its job is under way (see enableParallelControl).
function startParallelControl(parallel) {
  dropParallelChange();
  serverParallel = parallel;
  isParallelEnabled = false;
  lastActiveCount = 0;
}

// the run's job has started: the control works from now, not its first poll
function enableParallelControl() {
  isParallelEnabled = true;
  showParallel();
}

function dropParallelChange() {
  clearTimeout(parallelTimer);
  parallelTimer = null;
  pendingParallel = null;
}

// The person picked a number: show it at once, and send it once they've
// settled (the slider reports every step of a drag, the buttons each click,
// so only the latest number goes). The batch's next run starts with it too.
function changeParallel(value) {
  const parallel = clampParallel(value);
  if (!activeJob || !isParallelEnabled || parallel === shownParallel()) return;
  pendingParallel = parallel;
  $("parallel").value = String(parallel);
  showParallel();
  clearTimeout(parallelTimer);
  parallelTimer = setTimeout(settleParallel, PARALLEL_DEBOUNCE_MS);
}

function settleParallel() {
  parallelTimer = null;
  sendParallel();
}

// a signal that gives up after `ms`, where the browser can make one
function timeoutSignal(ms) {
  const canTimeOut = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  return canTimeOut ? AbortSignal.timeout(ms) : undefined;
}

// POST /jobs/:id/parallel. Resolves with { job } (the run as /progress shows
// it) or { error } (worded for the log).
async function postParallel(jobId, parallel) {
  try {
    const res = await fetch(`/jobs/${encodeURIComponent(jobId)}/parallel`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ parallel }),
      signal: timeoutSignal(PARALLEL_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) return { error: body?.error || "Could not change how many download at once." };
    return { job: body };
  } catch (e) {
    if (e?.name === "TimeoutError") return { error: "The server took too long to change how many download at once." };
    return { error: "Could not reach the server. Is it running?" };
  }
}

// Send the person's choice, one change at a time: a number picked while
// another is on its way goes once that one is answered. An answer only
// counts for the run it was sent for.
async function sendParallel() {
  if (!activeJob || !isParallelEnabled) return;
  const parallel = parallelToSend({ pending: pendingParallel, server: serverParallel, isSending: isSendingParallel });
  if (parallel == null) {
    // back on the server's number (nothing to send), or wait for the answer on its way
    if (!isSendingParallel) pendingParallel = null;
    return;
  }

  const jobId = activeJob.id;
  isSendingParallel = true;
  const answer = await postParallel(jobId, parallel);
  isSendingParallel = false;
  parallelAnswers += 1;
  if (activeJob?.id === jobId) takeParallelAnswer(answer, parallel);
  if (parallelTimer == null) sendParallel(); // a number picked meanwhile goes now
}

// What the server said to a change: the run as /progress shows it (its
// events are logged already) with its limit, or why not. Either way the
// person's choice is settled, unless they picked another meanwhile.
function takeParallelAnswer(answer, sent) {
  pendingParallel = pendingAfterAnswer(pendingParallel, sent);
  if (answer.error) {
    log(answer.error, "warn");
    showParallel(); // back to the server's number, unless another was picked meanwhile
    return;
  }

  const { job } = answer;
  serverParallel = Number.isInteger(job.parallel) ? job.parallel : sent;
  activeJob = { id: activeJob.id, control: job.control ?? activeJob.control };
  renderJob(job, parallelAnswers);
  renderLiveStats(job);
  // said once the person's latest choice is in, and not once Stop was asked for
  if (pendingParallel == null && job.control !== "stop" && !isBatchStopped) {
    log(parallelChangedText(serverParallel, activeCountOf(job), job.control));
  }
}

// What the log says once a new limit is in. Paused, nothing downloads
// until the run resumes.
function parallelChangedText(parallel, activeCount, control = "run") {
  if (control === "pause") return `Up to ${parallel} at once when you resume.`;
  const text = `Now downloading up to ${parallel} at once.`;
  return activeCount > parallel ? `${text} Songs already in progress finish first.` : text;
}

// No more changes: one not sent yet is dropped (the next run starts with it
// all the same, see changeParallel) and the control locks. On Stop it locks
// at the click, before the server answers: a stopping run can't use a change.
function lockParallelControl() {
  dropParallelChange();
  isParallelEnabled = false;
  showParallel();
}

// once the run is over there's nothing left to change, and nothing running
function endParallelControl() {
  lastActiveCount = 0;
  lockParallelControl();
}

// --- the Live stats card ---

// the charts, by the id of the box each one is drawn in
const CHART_BUILDERS = {
  progressChart: drawProgressChart,
  speedChart: (job) => Charts.speedChart(job.history),
  outcomeChart: (job) => Charts.outcomeDonut(outcomeParts(job)),
};

// The Songs done chart, its time axis carried on from the run's last
// drawing, so the axis only moves in steps rather than with every new
// time left
function drawProgressChart(job) {
  const previousSpanMs = progressAxis.jobId === job.id ? progressAxis.spanMs : null;
  const svg = Charts.progressChart(job.history, { total: job.total, etaMs: projectedEtaMs(job), previousSpanMs });
  const spanMs = Number(svg.getAttribute("data-span-ms"));
  if (spanMs > 0) progressAxis = { jobId: job.id, spanMs };
  return svg;
}

// an older server sends neither, and then the card stays hidden
function hasLiveStats(job) {
  return Array.isArray(job?.history) && Array.isArray(job?.recent);
}

// The ring's parts: the songs done, as saved / reused / skipped / to review
// / failed, and the songs still to go, so the ring always adds up to the
// run's song count and its middle reads the songs done. Every part comes out
// of the songs done: picks a stopped or failed "Download selected" run puts
// back on the review list were never worked through, so they stay in "left"
// rather than also counting as to review. Reused songs get their own part,
// so they're taken out of the saved ones (which count them).
function outcomeParts(job) {
  const { saved, reused, skipped, toReview } = countsOf(job);
  const total = Math.max(0, job.total ?? 0);
  const done = Math.min(Math.max(0, job.done ?? 0), total);
  const savedPart = Math.min(saved, done);
  const reusedPart = Math.min(reused, savedPart);
  const skippedPart = Math.min(skipped, done - savedPart);
  const review = Math.min(toReview, done - savedPart - skippedPart);
  const failed = done - savedPart - skippedPart - review;
  return { saved: savedPart - reusedPart, reused: reusedPart, skipped: skippedPart, review, failed, left: total - done };
}

// The dashed "at this pace" line ends where the countdown does; a run that's
// stopping, or over, won't get there.
function projectedEtaMs(job) {
  if (job.status !== "running" || job.control === "stop") return null;
  return remainingAt(liveCountdown, Date.now());
}

// A chart being read (pointer on it, or keyboard focus in it) isn't redrawn
// under the reader: it catches up as soon as they move off.
function isBeingRead(id) {
  return chartsBeingRead.has(id) || $(id).contains(document.activeElement);
}

function renderChart(id) {
  if (!statsJob || isBeingRead(id)) return;
  $(id).replaceChildren(CHART_BUILDERS[id](statsJob));
}

function watchChartReading() {
  for (const id of Object.keys(CHART_BUILDERS)) {
    const box = $(id);
    box.addEventListener("pointerenter", () => chartsBeingRead.add(id));
    box.addEventListener("pointerleave", () => {
      chartsBeingRead.delete(id);
      renderChart(id);
    });
    box.addEventListener("focusout", () => renderChart(id));
  }
}

// the ring's legend, in the ring's order, with each part's count; Reused
// only once a song has been (most runs reuse none, and an older server never)
function renderOutcomeLegend(parts) {
  const shown = Charts.OUTCOMES.filter(({ key }) => key !== "reused" || parts.reused > 0);
  const items = shown.map(({ key, label }) => {
    const swatch = el("span", "legend-swatch");
    swatch.dataset.part = key;
    const item = el("li", "legend-item");
    item.append(swatch, el("span", "legend-label", label), el("span", "legend-count", String(parts[key])));
    return item;
  });
  $("outcomeLegend").replaceChildren(...items);
}

// What a "Recently finished" row says about one song from `recent`
function recentView(item) {
  const outcome = String(item?.outcome ?? "");
  const number = Number.isFinite(item?.number) ? `${item.number}. ` : "";
  const name = [item?.title, item?.artist]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" — ");
  const isKept = outcome === "saved" || outcome === "reused";
  const size = isKept && Number.isFinite(item?.bytes) ? formatBytes(item.bytes) : "";
  const took = Number.isFinite(item?.tookMs) ? formatDuration(item.tookMs) : "";
  // a reused song says where it was copied from ("copied from <folder>")
  const hasReason = ["review", "failed", "reused"].includes(outcome) && item?.reason;
  return {
    outcome,
    chip: Object.hasOwn(OUTCOME_CHIPS, outcome) ? OUTCOME_CHIPS[outcome] : outcome,
    title: `${number}${name}`,
    details: [size, took].filter(Boolean).join(" · "),
    reason: hasReason ? String(item.reason) : "",
  };
}

function renderRecentRow(view) {
  const chip = el("span", "recent-chip", view.chip);
  chip.dataset.outcome = view.outcome;
  const song = el("div", "recent-song");
  song.append(el("div", "recent-title", view.title));
  if (view.reason) song.append(el("div", "recent-reason", view.reason));
  const row = el("li", "recent-item");
  row.append(chip, song, el("span", "recent-details", view.details));
  return row;
}

// rebuilt only when it changed, so a title someone is selecting stays selected
function renderRecent(recent) {
  const key = JSON.stringify(recent);
  if (key === shownRecentKey) return;
  shownRecentKey = key;
  const rows = recent.map((item) => renderRecentRow(recentView(item)));
  $("recentList").replaceChildren(...(rows.length ? rows : [el("li", "recent-empty", "Nothing finished yet.")]));
}

// The card from a /progress snapshot. It stays up once the run is over, until
// the next run's first poll replaces it.
function renderLiveStats(job) {
  if (!hasLiveStats(job)) {
    $("statsPanel").classList.add("hidden");
    return;
  }
  statsJob = job;
  $("statsPanel").classList.remove("hidden");
  $("statsName").textContent = job.name ? `· ${job.name}` : "";
  for (const id of Object.keys(CHART_BUILDERS)) renderChart(id);
  renderOutcomeLegend(outcomeParts(job));
  renderRecent(job.recent);
}

// --- the batch panel (every run, with its outcome) ---

function renderBatchItem(item) {
  const row = el("li", "batch-item");
  row.dataset.status = item.status;

  const pill = el("span", "pill", STATUS_LABELS[item.status]);
  pill.dataset.status = item.status;

  const bar = el("div", "batch-bar");
  const fill = el("span");
  const fraction = item.total ? item.done / item.total : 0;
  fill.style.transform = `scaleX(${fraction})`;
  bar.append(fill);

  row.append(el("span", "batch-name", item.name), pill, bar, el("div", "batch-summary", item.summary));
  return row;
}

function renderBatch() {
  $("batchPanel").classList.toggle("hidden", batch.length < 2);
  $("batchList").replaceChildren(...batch.map(renderBatchItem));
}

// --- running a batch ---

// "8" -> 8, "50" -> 20, "lots" -> 3: the server allows 1–20 at once
function clampParallel(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL;
  return Math.min(MAX_PARALLEL, Math.max(1, n));
}

// the field then shows the number that will really be used
function readParallel() {
  const parallel = clampParallel($("parallel").value);
  $("parallel").value = String(parallel);
  return parallel;
}

function readOptions() {
  return {
    quality: $("quality").value,
    parallel: readParallel(),
    saveTo: $("saveTo").value.trim(),
    skipExisting: $("skipExisting").checked,
    cookiesBrowser: $("cookiesBrowser").value,
    extras: readExtras(),
  };
}

// POST that starts a job on the server. Resolves with the job id, or with
// null once the reason it didn't start is in the log.
async function requestJob(url, init) {
  let response;
  try {
    response = await fetch(url, { method: "POST", ...init });
  } catch (e) {
    log("Could not reach the server. Is it running?", "fail");
    return null;
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.jobId) {
    log(body?.error || "Server error.", "fail");
    return null;
  }
  return body.jobId;
}

function logDownloadStart(folder) {
  log(folder ? `Downloading into ${folder}…` : "Downloading…");
}

async function uploadPlaylist(file, options) {
  const form = new FormData();
  form.append("csv", file);
  form.append("quality", options.quality);
  form.append("parallel", options.parallel);
  form.append("saveTo", options.saveTo);
  form.append("skipExisting", options.skipExisting ? "1" : "0");
  form.append("cookiesBrowser", options.cookiesBrowser);
  for (const [name, isOn] of Object.entries(options.extras)) form.append(name, isOn ? "1" : "0");

  const jobId = await requestJob("/upload", { body: form });
  if (jobId) logDownloadStart(options.saveTo);
  return jobId;
}

// Check the job once a second until it's over, logging each finished song.
// Resolves with the final job, or null if the server lost it.
async function followJob(jobId, item) {
  lastEventSeq = 0;

  while (true) {
    await sleep(POLL_MS);
    const answersAtPoll = parallelAnswers; // the answer can't know of changes answered after this
    let res;
    try {
      res = await fetch(`/progress?job=${encodeURIComponent(jobId)}&after=${lastEventSeq}`);
    } catch (e) {
      continue; // network blip, try again next tick
    }
    if (!res.ok) return null; // the job vanished (server restarted)

    const job = await res.json().catch(() => null);
    if (!job) continue;

    for (const event of job.events ?? []) {
      log(event.text);
      lastEventSeq = event.seq;
      suggestSignInOnBotCheck(event.text);
    }

    activeJob = { id: jobId, control: job.control ?? "run" };
    item.done = job.done;
    item.total = job.total;
    item.status = job.control === "pause" ? "paused" : "running";
    item.summary = countsText(job);
    item.settled = withSettledSongs(item.settled, job.recent);
    renderJob(job, answersAtPoll);
    renderLiveStats(job);
    renderBatch();

    if (job.status !== "running") return job;
  }
}

function downloadZip(jobId) {
  const link = el("a");
  link.href = `/download/${encodeURIComponent(jobId)}`;
  link.download = ""; // the server names it "<playlist>.zip"
  document.body.append(link);
  link.click();
  link.remove();
}

// Log the outcome and set the batch entry's final status. Whatever the
// outcome, the songs the run couldn't settle by itself go to the review list,
// and the rows of songs it did settle leave it. The run is then seen: a
// later load of the page doesn't take it in again.
function finishPlaylist(item, job) {
  if (!job) {
    log("Lost track of the job on the server. Please try again.", "fail");
    endRunPanel("failed");
    item.status = "failed";
    item.summary = "Lost track of the job";
    return;
  }

  reportOutcome(item, job);
  item.takeReviews(job, settledSongsOf(job, item.settled));
  rememberSeenJobs([job.id]);
}

function reportOutcome(item, job) {
  const wasStopped = job.control === "stop";
  const hasSaved = countsOf(job).saved > 0;
  if (job.status === "error") {
    log(job.error || "Server error.", wasStopped ? "warn" : "fail");
    // a run stopped before it saved anything was stopped, not failed
    endRunPanel(wasStopped ? "stopped" : "failed", hasSaved);
    $("statTime").textContent = `${formatDuration(job.elapsedMs ?? 0)} in total`;
    item.status = wasStopped ? "stopped" : "failed";
    item.summary = job.error || "Failed";
    return;
  }

  endRunPanel(wasStopped ? "stopped" : "done", hasSaved);
  item.status = wasStopped ? "stopped" : "done";
  const time = formatDuration(job.elapsedMs ?? 0);
  $("statTime").textContent = `${time} in total`;
  const prefix = wasStopped ? "Stopped. " : "";
  const kind = wasStopped ? "warn" : "ok";

  if (job.status === "saved") {
    item.summary = `${countsText(job)} · ${formatBytes(job.savedBytes ?? 0)} · ${time}`;
    log(`${prefix}${countsText(job)} (${formatBytes(job.savedBytes ?? 0)}) in ${job.saveFolder}, ${time}`, kind);
    if (typeof job.playlistFile === "string" && job.playlistFile) log(`Playlist file: ${job.playlistFile}`);
    log("If that's a pen drive, eject it before unplugging it.");
    return;
  }

  // "ready": the songs wait in a ZIP for the browser to fetch
  item.summary = `${countsText(job)} · ${formatBytes(job.zipBytes)} · ${time}`;
  log(`${prefix}${countsText(job)} (${formatBytes(job.zipBytes)}), ${time}`, kind);
  log(`Saving "${item.zipName ?? job.name ?? "songs"}.zip": watch your browser's downloads.`);
  downloadZip(job.id);
}

// One entry of the batch: start its job, follow it to the end, report it
async function runPlaylist(item, options) {
  item.status = "running";
  renderBatch();
  // read for each run: a number picked with the live control carries over
  const runOptions = { ...options, parallel: readParallel() };
  resetRunPanel(item.name, runOptions.parallel);
  log(`▶ ${item.name}`, "heading");

  const jobId = await item.startJob(runOptions);
  if (!jobId) {
    endRunPanel("failed");
    item.status = "failed";
    item.summary = "Could not start";
    return;
  }

  activeJob = { id: jobId, control: "run" };
  enableParallelControl();
  const job = await followJob(jobId, item);
  activeJob = null;
  finishPlaylist(item, job);
  alertPlaylistEnd(item, job);
}

// One run in the batch panel. startJob(options) starts its job on the server
// (a CSV upload, or picked songs) and resolves with the job id, or null.
// takeReviews(job, settled) puts what the ended job couldn't settle on the
// review list and, unless an entry says otherwise, takes the songs it did
// settle off it (see addReviews). isPicks: a "Download selected" run, whose
// song count isn't its playlist's. settled: the songs the run has settled,
// as its polls showed them (see withSettledSongs).
function batchEntry(fields) {
  const takeReviews = (job, settled) => addReviews(job.reviews, playlistOfJob(job, fields), settled);
  return { zipName: null, isPicks: false, takeReviews, ...fields, status: "waiting", summary: "", done: 0, total: 0, settled: [] };
}

// The playlist an ended job's songs to review belong to: its name, its
// folder, and its song count (its files are numbered against it), which a
// "Download selected" run doesn't know.
function playlistOfJob(job, { playlistName, isPicks = false }) {
  return {
    name: playlistName,
    saveFolder: job.saveFolder ?? null,
    trackTotal: !isPicks && Number.isInteger(job.total) ? job.total : null,
  };
}

// --- the songs a run settled ---

// What became of a song that settles it: saved, copied in from another
// playlist, or skipped as already saved. (A row skipped as listed twice in
// the CSV is settled by its first row, so it isn't counted here.)
function isSettledOutcome(item) {
  const outcome = item?.outcome;
  return outcome === "saved" || outcome === "reused" || (outcome === "skipped" && !item.reason);
}

// The songs settled so far plus the ones a poll's list of recently
// finished songs adds: { number, title, artist } each, each song once
function withSettledSongs(settled, recent) {
  const known = new Set(settled.map(settledSongKey));
  const added = [];
  for (const item of Array.isArray(recent) ? recent : []) {
    if (!isSettledOutcome(item)) continue;
    const song = { number: item.number, title: String(item.title ?? ""), artist: String(item.artist ?? "") };
    const key = settledSongKey(song);
    if (known.has(key)) continue;
    known.add(key);
    added.push(song);
  }
  return added.length ? [...settled, ...added] : settled;
}

function settledSongKey(song) {
  return JSON.stringify([song.number, matchText(song.title), matchText(song.artist)]);
}

// A run's settled songs: the server's whole list once the run is over, when
// it sends one; otherwise what its polls showed (`seen`), plus the ended
// run's own list of recently finished songs.
function settledSongsOf(job, seen = []) {
  if (Array.isArray(job.settled)) return job.settled;
  return withSettledSongs(seen, job.recent);
}

function setBatchRunning(isRunning) {
  isBatchRunning = isRunning;
  $("startButton").disabled = isRunning;
  renderReviewSummary(); // the review list's Download button waits too
}

// Run the entries one after another; Stop cancels the ones still waiting.
// Nothing else can start until they're all done.
async function runBatch(entries, options) {
  isBatchStopped = false;
  setBatchRunning(true);
  renderBatch();

  try {
    for (const item of entries) {
      if (isBatchStopped) {
        item.status = "stopped";
        item.summary = "Not started";
        continue;
      }
      await runPlaylist(item, options);
      renderBatch();
    }
    renderBatch();
    if (entries.length > 1) {
      logBatchSummary(entries);
      alertBatchEnd(entries);
    }
  } finally {
    stopCountdown(); // each run stops its own; this one covers a run that broke off
    setBatchRunning(false);
  }
}

// "3 done · 1 stopped · 1 failed"
function batchSummaryText(entries) {
  const count = (status) => entries.filter((item) => item.status === status).length;
  return [
    `${count("done")} done`,
    count("stopped") ? `${count("stopped")} stopped` : "",
    count("failed") ? `${count("failed")} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function logBatchSummary(entries) {
  log(`Batch finished: ${batchSummaryText(entries)}`, "heading");
}

async function startBatch() {
  const files = [...$("csvFile").files];
  if (!files.length) {
    alert("Please select at least one CSV file.");
    return;
  }
  if (isBatchRunning) {
    log("A run is already in progress.", "warn");
    return;
  }
  prepareFinishAlert(); // while the click still counts as one (before any await)

  batch = files.map((file) =>
    batchEntry({
      name: playlistName(file.name),
      playlistName: playlistName(file.name),
      startJob: (options) => uploadPlaylist(file, options),
    })
  );
  await runBatch(batch, readOptions());
}

// --- Pause / Resume / Stop ---

async function sendControl(action) {
  if (!activeJob) return;
  const jobId = activeJob.id;
  const answersAtPoll = parallelAnswers; // see renderParallel
  try {
    const res = await fetch(`/jobs/${encodeURIComponent(jobId)}/${action}`, {
      method: "POST",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log(body.error || `Could not ${action}.`, "warn");
      return;
    }
    if (activeJob?.id !== jobId) return; // that run ended meanwhile
    activeJob = { id: jobId, control: body.control };
    // the answer is the run as /progress shows it: the countdown freezes on
    // Pause and the live control locks on Stop right away
    renderJob(body, answersAtPoll);
  } catch (e) {
    log("Could not reach the server. Is it running?", "fail");
  }
}

function togglePause() {
  if (!activeJob) return;
  if (activeJob.control === "pause") {
    log("Resuming.", "warn");
    sendControl("resume");
  } else {
    log("Pausing: songs already downloading finish first.", "warn");
    sendControl("pause");
  }
}

function stopRun() {
  if (!activeJob) return;
  const waiting = batch.filter((item) => item.status === "waiting").length;
  const message =
    "Stop downloading? Songs already saved are kept." +
    (waiting ? ` The ${waiting} playlist(s) still waiting in this batch won't start.` : "");
  if (!confirm(message)) return;

  isBatchStopped = true;
  lockParallelControl();
  log("Stopping…", "warn");
  sendControl("stop");
}

// --- the review list: songs without a sure match ---

// /picks downloads by YouTube video id, so a candidate without a valid one is no use
function isUsableCandidate(candidate) {
  return typeof candidate?.videoId === "string" && VIDEO_ID_PATTERN.test(candidate.videoId);
}

// What the review table reads of an upload, in the types it expects (its
// link is made from the video id, and its view count isn't shown)
function tableCandidate(candidate) {
  return {
    videoId: candidate.videoId,
    title: String(candidate.title ?? ""),
    channel: String(candidate.channel ?? ""),
    durationSec: Number.isFinite(candidate.durationSec) ? candidate.durationSec : null,
    thumbnail: typeof candidate.thumbnail === "string" ? candidate.thumbnail : null,
    score: Number.isFinite(candidate.score) ? candidate.score : 0,
    label: typeof candidate.label === "string" ? candidate.label : null,
    variant: Array.isArray(candidate.variant) ? candidate.variant.map(String) : [],
  };
}

// the uploads of a list (from the server, or saved on this browser) the table can use
function usableCandidates(list) {
  return (Array.isArray(list) ? list : []).filter(isUsableCandidate).map(tableCandidate);
}

// Ticked by default only when it's a sure match. A "Possible" upload can be a
// live take, a long cut or another song, so the person ticks it on purpose.
function isWorthTicking(candidate) {
  const isOtherVersion = Array.isArray(candidate?.variant) && candidate.variant.length > 0;
  return candidate?.label === "Good match" && !isOtherVersion;
}

function chosenCandidate(item) {
  return item.candidates.find((candidate) => candidate.videoId === item.chosenId) ?? null;
}

function songLabel(song) {
  return `${song.title} — ${song.artist}`;
}

// the match pill's color (data-label), from the server's label
function matchKind(label) {
  if (label === "Good match") return "good";
  if (label === "Possible") return "possible";
  if (label === "Unlikely") return "unlikely";
  return "";
}

// One song from a finished job's `reviews`, with its best upload picked
function reviewItemFrom(review, playlist) {
  const text = (value) => String(value ?? "");
  const candidates = usableCandidates(review.candidates);
  lastReviewKey += 1;
  return {
    key: lastReviewKey,
    playlist,
    song: {
      number: review.number,
      title: text(review.title),
      artist: text(review.artist),
      album: text(review.album),
      year: text(review.year),
      genre: text(review.genre),
      durationSec: Number.isFinite(review.durationSec) ? review.durationSec : null,
    },
    reason: text(review.reason),
    candidates,
    chosenId: candidates[0]?.videoId ?? null,
    isSelected: isWorthTicking(candidates[0]),
    isSearching: false,
  };
}

// A title or artist as songs are told apart: however it's capitalised, and
// whether its accents are written as one character or two (é or e + ´)
function matchText(value) {
  return String(value ?? "").normalize("NFC").trim().toLowerCase();
}

// a song of a playlist (name and folder), as the list tells songs apart
function songKey(playlist, song) {
  return JSON.stringify([playlistKey(playlist), matchText(song.title), matchText(song.artist)]);
}

// the same song of the same playlist (and folder)
function isSameSong(a, b) {
  return songKey(a.playlist, a.song) === songKey(b.playlist, b.song);
}

// A run's songs join the list, each once. A song the list has already
// (running a playlist again lists its unsettled songs again) keeps its row,
// with its pick and tick, and takes the new reason and any new uploads.
// `settled`: the songs the run saved, copied in or skipped as already
// saved ({ title, artist }): their rows for the playlist go, since they're
// done with (unless the run listed them again).
function addReviews(reviews, playlist, settled = []) {
  const listed = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const item = reviewItemFrom(review, playlist);
    const key = songKey(playlist, item.song);
    if (!listed.has(key)) listed.set(key, item);
  }
  const settledKeys = new Set(settled.map((song) => songKey(playlist, song)));
  const isDone = (key) => settledKeys.has(key) && !listed.has(key);

  const kept = reviewItems.filter((item) => !isDone(songKey(item.playlist, item.song)));
  const keptKeys = new Set(kept.map((item) => songKey(item.playlist, item.song)));
  const updated = kept.map((item) => {
    const newer = listed.get(songKey(item.playlist, item.song));
    return newer ? withMoreCandidates({ ...item, reason: newer.reason }, newer.candidates) : item;
  });
  const added = [...listed.entries()].filter(([key]) => !keptKeys.has(key)).map(([, item]) => item);
  if (!listed.size && kept.length === reviewItems.length) return; // nothing changed

  setReviewItems([...updated, ...added]);
  renderReview();
  if (listed.size) log(`${listed.size} song(s) need a look: see the review list below.`, "review");
}

function reviewItemByKey(key) {
  return reviewItems.find((item) => item.key === key);
}

// swap one entry for a changed copy, and return the copy
function updateReviewItem(key, changes) {
  setReviewItems(reviewItems.map((item) => (item.key === key ? { ...item, ...changes } : item)));
  return reviewItemByKey(key);
}

// picked songs download per playlist: the same name and the same folder
function playlistKey(playlist) {
  return JSON.stringify([playlist.name, playlist.saveFolder]);
}

function showsPlaylistNames() {
  return new Set(reviewItems.map((item) => playlistKey(item.playlist))).size > 1;
}

function isDownloadable(item) {
  return item.isSelected && item.chosenId != null;
}

// Rebuilding rows replaces their controls, so put focus back on the same
// control (matched by data-focus): keyboard users keep their place.
function keepFocus(render) {
  const focusId = document.activeElement?.dataset?.focus;
  render();
  if (focusId) document.querySelector(`[data-focus="${focusId}"]`)?.focus();
}

function renderReview() {
  $("reviewPanel").classList.toggle("hidden", reviewItems.length === 0);
  $("reviewCount").textContent = String(reviewItems.length);
  const showPlaylist = showsPlaylistNames();
  const rows = reviewItems.map((item) => renderReviewRow(item, showPlaylist));
  keepFocus(() => $("reviewBody").replaceChildren(...rows));
  renderReviewSummary();
}

function replaceReviewRow(key) {
  const item = reviewItemByKey(key);
  const row = $("reviewBody").querySelector(`tr[data-key="${key}"]`);
  if (!item || !row) return;
  keepFocus(() => row.replaceWith(renderReviewRow(item, showsPlaylistNames())));
}

// the header checkbox, "N selected" and the Download button
function renderReviewSummary() {
  const tickable = reviewItems.filter((item) => item.candidates.length > 0).length;
  const selected = reviewItems.filter(isDownloadable).length;
  const selectAll = $("reviewSelectAll");
  selectAll.disabled = tickable === 0;
  selectAll.checked = tickable > 0 && selected === tickable;
  selectAll.indeterminate = selected > 0 && selected < tickable;
  $("reviewSelected").textContent = `${selected} selected`;
  $("reviewDownload").disabled = selected === 0 || isBatchRunning;
  // a "Download selected" run settles its rows once it ends, so they stay till then
  $("reviewClear").disabled = reviewItems.length === 0 || isBatchRunning;
}

function selectAllReview(isSelected) {
  setReviewItems(reviewItems.map((item) => (item.candidates.length ? { ...item, isSelected } : item)));
  renderReview();
}

function renderReviewRow(item, showPlaylist) {
  const row = el("tr");
  row.dataset.key = String(item.key);
  const matchCell = el("td", "col-match");
  matchCell.append(el("span", "pill match-pill"));
  row.append(
    renderCheckCell(item),
    renderSongCell(item, showPlaylist),
    renderPickCell(item, row),
    matchCell
  );
  showChoice(row, item);
  return row;
}

function renderCheckCell(item) {
  const box = el("input");
  box.type = "checkbox";
  box.checked = item.isSelected;
  box.disabled = item.candidates.length === 0;
  box.dataset.focus = `${item.key}:check`;
  box.setAttribute("aria-label", `Select ${songLabel(item.song)}`);
  box.addEventListener("change", () => {
    updateReviewItem(item.key, { isSelected: box.checked });
    renderReviewSummary();
  });

  const cell = el("td", "col-check");
  cell.append(box);
  return cell;
}

function renderSongCell(item, showPlaylist) {
  const cell = el("th", "col-song");
  cell.scope = "row";
  const reason = showPlaylist ? `${item.playlist.name} · ${item.reason}` : item.reason;
  cell.append(el("div", "review-song", songLabel(item.song)), el("div", "review-reason", reason));
  return cell;
}

// thumbnail and list of uploads, with the YouTube link and Search wider below
function renderPickCell(item, row) {
  const hasCandidates = item.candidates.length > 0;
  const pick = el("div", hasCandidates ? "pick" : "pick is-empty");
  const actions = el("div", "pick-actions");
  if (hasCandidates) {
    pick.append(renderThumbnail(), renderPickSelect(item, row));
    actions.append(renderOpenLink(item));
  } else {
    pick.append(el("span", "review-none", "No matches yet"));
  }
  actions.append(renderWiderButton(item));
  pick.append(actions);

  const cell = el("td", "col-pick");
  cell.append(pick);
  return cell;
}

// an empty frame: showChoice loads the chosen upload's picture into it
function renderThumbnail() {
  const img = el("img", "review-thumb");
  img.alt = "";
  img.width = 64;
  img.height = 36;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  return img;
}

function renderPickSelect(item, row) {
  const select = el("select");
  select.dataset.focus = `${item.key}:pick`;
  select.setAttribute("aria-label", `Pick a match for ${item.song.title}`);
  select.append(...item.candidates.map(renderCandidateOption));
  select.value = item.chosenId;
  select.addEventListener("change", () => {
    const updated = updateReviewItem(item.key, { chosenId: select.value });
    if (updated) showChoice(row, updated);
  });
  return select;
}

// "<title> · <channel> · 4:05"
function renderCandidateOption(candidate) {
  const length = candidate.durationSec ? formatClock(candidate.durationSec) : "";
  const text = [candidate.title, candidate.channel, length].filter(Boolean).join(" · ");
  const option = el("option", null, text);
  option.value = candidate.videoId;
  return option;
}

function renderOpenLink(item) {
  const link = el("a", "review-open", "Open ↗");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.dataset.focus = `${item.key}:open`;
  return link;
}

function renderWiderButton(item) {
  const button = el("button", "button secondary small");
  button.type = "button";
  button.dataset.focus = `${item.key}:wider`;
  showSearchState(button, item);
  button.addEventListener("click", () => searchWider(item.key, button));
  return button;
}

function showSearchState(button, item) {
  button.textContent = item.isSearching ? "Searching…" : "Search wider";
  button.disabled = item.isSearching;
  const action = item.isSearching ? "Searching" : "Search wider";
  button.setAttribute("aria-label", `${action} for ${item.song.title}`);
}

// Show the chosen upload in its row: thumbnail, YouTube link and match pill
function showChoice(row, item) {
  const chosen = chosenCandidate(item);
  const thumb = row.querySelector(".review-thumb");
  const link = row.querySelector(".review-open");
  const pill = row.querySelector(".match-pill");

  if (thumb) setThumbnail(thumb, chosen?.thumbnail);
  if (link && chosen) {
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(item.chosenId)}`;
    link.setAttribute("aria-label", `Open ${chosen.title} on YouTube (new tab)`);
  }
  pill.classList.toggle("hidden", !chosen?.label);
  pill.textContent = chosen?.label ?? "";
  pill.dataset.label = matchKind(chosen?.label);
  pill.title = chosen ? matchDetails(chosen) : "";
}

// only YouTube's https thumbnails are loaded; anything else leaves the box empty
function setThumbnail(img, url) {
  if (typeof url === "string" && url.startsWith("https://")) img.src = url;
  else img.removeAttribute("src");
}

// the pill's tooltip: how close the match is, and what looks off about it
function matchDetails(candidate) {
  const percent = `${Math.round((candidate.score ?? 0) * 100)}% match`;
  const variant = Array.isArray(candidate.variant) ? candidate.variant.join(", ") : "";
  return variant ? `${percent} · ${variant}` : percent;
}

// --- Search wider ---

// more uploads to choose from: the server runs wider searches for the song
async function fetchAlternatives(song) {
  const query = {
    title: song.title.slice(0, MAX_SEARCH_TEXT),
    artist: song.artist.slice(0, MAX_SEARCH_TEXT),
    album: song.album.slice(0, MAX_SEARCH_TEXT),
    durationSec: song.durationSec,
  };
  let response;
  try {
    response = await fetch("/alternatives", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(query),
    });
  } catch (e) {
    throw new Error("could not reach the server. Is it running?", { cause: e });
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || "server error.");
  return usableCandidates(body?.candidates);
}

// both lists' uploads, each video once, best score first
function mergeCandidates(current, found) {
  const byId = new Map();
  for (const candidate of [...current, ...found]) {
    if (!byId.has(candidate.videoId)) byId.set(candidate.videoId, candidate);
  }
  return [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// The entry once a wider search has found more. The pick stays if it's still
// listed; a row that couldn't be ticked before (nothing to pick) is ticked
// when its new pick is a sure match.
function withMoreCandidates(item, found) {
  const candidates = mergeCandidates(item.candidates, found);
  const isPickKept = candidates.some((candidate) => candidate.videoId === item.chosenId);
  const chosenId = isPickKept ? item.chosenId : candidates[0]?.videoId ?? null;
  const chosen = candidates.find((candidate) => candidate.videoId === chosenId);
  const hadNothing = item.candidates.length === 0;
  const isSelected = item.isSelected || (hadNothing && isWorthTicking(chosen));
  return { ...item, candidates, chosenId, isSelected };
}

async function searchWider(key, button) {
  const item = reviewItemByKey(key);
  if (!item || item.isSearching) return;
  showSearchState(button, updateReviewItem(key, { isSearching: true }));

  let found = null;
  try {
    found = await fetchAlternatives(item.song);
  } catch (e) {
    log(`Could not search wider for ${songLabel(item.song)}: ${e.message}`, "warn");
  }

  const current = reviewItemByKey(key);
  if (!current) return; // downloaded (and so dropped from the list) meanwhile
  const updated = found ? withMoreCandidates(current, found) : current;
  updateReviewItem(key, { ...updated, isSearching: false });
  replaceReviewRow(key);
  renderReviewSummary();
  if (found) logSearchOutcome(current, updated);
}

function logSearchOutcome(before, after) {
  const added = after.candidates.length - before.candidates.length;
  const label = songLabel(after.song);
  log(added ? `Found ${added} more for ${label}.` : `Nothing new found for ${label}.`);
}

// --- Download selected ---

// [a, b, c, d, e] in 2s -> [[a, b], [c, d], [e]]
function chunk(list, size) {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size)
  );
}

// The ticked songs as /picks jobs: one per playlist (name and folder), split
// so no job goes over the server's limit.
function selectedGroups() {
  const byPlaylist = new Map();
  for (const item of reviewItems.filter(isDownloadable)) {
    const id = playlistKey(item.playlist);
    byPlaylist.set(id, [...(byPlaylist.get(id) ?? []), item]);
  }
  return [...byPlaylist.values()].flatMap((items) =>
    chunk(items, MAX_PICKS_PER_JOB).map((part) => ({ playlist: items[0].playlist, items: part }))
  );
}

// What /picks needs per song: the chosen upload, the tags to write, and the
// song's row in its CSV out of the CSV's song count (for numbered files and
// the playlist file). Anything unknown is left out rather than sent as null.
function pickedSong({ song, chosenId, playlist }) {
  const { title, artist, album, year, genre, durationSec } = song;
  return {
    title,
    artist,
    album,
    year,
    genre,
    durationSec: durationSec ?? undefined,
    videoId: chosenId,
    number: Number.isInteger(song.number) ? song.number : undefined,
    trackTotal: Number.isInteger(playlist.trackTotal) ? playlist.trackTotal : undefined,
  };
}

// The group's rows as they are when its job starts: a pick changed, or a row
// unticked, while an earlier group was downloading still counts.
function currentPicks(keys) {
  return reviewItems.filter((item) => keys.has(item.key) && isDownloadable(item));
}

async function startPicks(playlist, items, options) {
  const { name, saveFolder } = playlist;
  if (!items.length) {
    log(`Nothing left to download for ${name}: its songs were unticked.`, "warn");
    return null;
  }
  const jobId = await requestJob("/picks", {
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name,
      saveFolder,
      quality: options.quality,
      parallel: options.parallel,
      cookiesBrowser: options.cookiesBrowser,
      ...options.extras, // the server ignores reuseSongs for picks
      songs: items.map(pickedSong),
    }),
  });
  if (jobId) logDownloadStart(saveFolder);
  return jobId;
}

// A row the server listed again: its reason, and any uploads it sent along
// (a stopped pick comes back as just its video, so the row's own list wins).
function withServerReview(item, review) {
  const found = usableCandidates(review.candidates);
  const reason = review.reason == null ? item.reason : String(review.reason);
  return { ...item, reason, candidates: mergeCandidates(item.candidates, found) };
}

// a review naming this song (see matchText)
function namesSong(review, song) {
  return matchText(review?.title) === matchText(song.title) && matchText(review?.artist) === matchText(song.artist);
}

// The server's review of one sent row, if it listed it again: the one naming
// the same song (a playlist's rows are different songs, see addReviews), or
// else one numbered where the row was sent that names none of the sent rows.
// (Picks now carry their CSV row number, so a server may number them by that.)
function reviewOfPick(item, position, reviews, sent) {
  return (
    reviews.find((review) => namesSong(review, item.song)) ??
    reviews.find((review) => review.number === position && !sent.some((other) => namesSong(review, other.song)))
  );
}

// Once a picked run has ended, a song it saved leaves the list. The server
// lists every other one again (its download failed, Stop, or the run failed):
// that row stays, keeping its uploads and pick. A row whose pick was changed
// during the run stays too: that pick is still to come.
function settlePicks(sent, reviews) {
  const listed = Array.isArray(reviews) ? reviews : [];
  const outcomes = new Map(
    sent.map((item, i) => [item.key, { sentId: item.chosenId, review: reviewOfPick(item, i + 1, listed, sent) }])
  );

  setReviewItems(
    reviewItems.flatMap((item) => {
      const outcome = outcomes.get(item.key);
      if (!outcome) return [item];
      if (outcome.review) return [withServerReview(item, outcome.review)];
      return item.chosenId === outcome.sentId ? [] : [item];
    })
  );
  renderReview();

  const listedAgain = [...outcomes.values()].filter((outcome) => outcome.review).length;
  if (listedAgain) log(`${listedAgain} song(s) need a look: see the review list below.`, "review");
}

// A batch entry for one group of picked songs. Its job takes the group's rows
// as they are when it starts, and settles those rows once it ends.
function pickedBatchEntry(group) {
  const name = `${group.playlist.name} (picked)`;
  const keys = new Set(group.items.map((item) => item.key));
  let sent = []; // the rows this entry's job was started with, in song-number order
  return batchEntry({
    name,
    playlistName: group.playlist.name,
    isPicks: true,
    zipName: name, // the server names the ZIP "<name> (picked).zip"
    startJob: (options) => {
      sent = currentPicks(keys);
      return startPicks(group.playlist, sent, options);
    },
    takeReviews: (job) => settlePicks(sent, job.reviews),
  });
}

// Download the ticked songs through the same run panel and batch list as a
// CSV run, listed after the runs they came from.
async function downloadSelected() {
  if (isBatchRunning) {
    log("A run is already in progress.", "warn");
    return;
  }
  const entries = selectedGroups().map(pickedBatchEntry);
  if (!entries.length) return;
  prepareFinishAlert(); // while the click still counts as one (before any await)

  batch = [...batch, ...entries];
  await runBatch(entries, readOptions());
}

// --- the review list, kept on this browser ---

// Saved after every change and read back on load, so a reload (or closing
// the tab) doesn't lose the songs waiting for a pick. Only on this browser;
// the newest MAX_SAVED_REVIEW_ROWS rows are kept, or as many as fit.
const REVIEW_LIST_KEY = "zipify.reviewList.v1";
const MAX_SAVED_REVIEW_ROWS = 2000;
let hasWarnedReviewSave = false;

// every change to the list goes through here, so the saved copy keeps up
function setReviewItems(items) {
  reviewItems = items;
  saveReviewList();
}

// a row as it's saved: all but its key (each load numbers the rows anew)
// and whether a search is running
function savedReviewRow({ playlist, song, reason, candidates, chosenId, isSelected }) {
  return { playlist, song, reason, candidates, chosenId, isSelected };
}

function saveReviewList() {
  const rows = reviewItems.slice(-MAX_SAVED_REVIEW_ROWS).map(savedReviewRow);
  try {
    if (!rows.length) {
      localStorage.removeItem(REVIEW_LIST_KEY);
      return;
    }
  } catch (e) {
    return; // blocked storage: there was nothing to keep anyway
  }
  if (storeNewest(REVIEW_LIST_KEY, rows) < rows.length) warnReviewListNotSaved();
}

// Stores as many of the newest rows as fit (all of them, else half, a
// quarter…) and says how many that was: 0 when storage is blocked.
function storeNewest(key, rows) {
  for (let count = rows.length; count > 0; count = Math.floor(count / 2)) {
    try {
      localStorage.setItem(key, JSON.stringify(rows.slice(-count)));
      return count;
    } catch (e) {
      // over what's left of this site's storage (or none at all): try fewer
    }
  }
  return 0;
}

function warnReviewListNotSaved() {
  if (hasWarnedReviewSave) return;
  hasWarnedReviewSave = true;
  log("This browser couldn't keep the whole review list: what isn't kept is lost once this page closes.", "warn");
}

// The saved list, on load. Rows are checked like anything read from outside:
// a broken one is left out, an upload without a valid video id is dropped.
function restoreReviewList() {
  let rows;
  try {
    rows = JSON.parse(localStorage.getItem(REVIEW_LIST_KEY) ?? "[]");
  } catch (e) {
    return; // blocked storage or a broken entry: the list starts empty
  }
  if (!Array.isArray(rows)) return;
  reviewItems = rows.map(restoredReviewItem).filter(Boolean);
  if (reviewItems.length) renderReview();
}

// a saved row as a list entry, with a new key; null when it's broken
function restoredReviewItem(row) {
  const playlist = savedPlaylist(row?.playlist);
  if (!playlist || typeof row.song?.title !== "string") return null;
  const item = reviewItemFrom({ ...row.song, reason: row.reason, candidates: row.candidates }, playlist);
  const isChosenListed = item.candidates.some((candidate) => candidate.videoId === row.chosenId);
  return {
    ...item,
    chosenId: isChosenListed ? row.chosenId : item.chosenId,
    isSelected: row.isSelected === true && item.candidates.length > 0,
  };
}

function savedPlaylist(playlist) {
  if (typeof playlist?.name !== "string") return null;
  return {
    name: playlist.name,
    saveFolder: typeof playlist.saveFolder === "string" ? playlist.saveFolder : null,
    trackTotal: Number.isInteger(playlist.trackTotal) ? playlist.trackTotal : null,
  };
}

// "Clear list": every row goes, here and in the saved copy, once confirmed
function clearReviewList() {
  const count = reviewItems.length;
  if (!count || isBatchRunning) return;
  const songs = count === 1 ? "1 song" : `${count} songs`;
  const message =
    `Clear all ${songs} from the review list? ` +
    "Running a playlist again lists its songs without a sure match again.";
  if (!confirm(message)) return;

  setReviewItems([]);
  renderReview();
  log(`Cleared ${songs} from the review list.`);
}

// --- runs that went on while this page wasn't following them ---

// The runs whose outcome this browser has taken in, by job id, so a run
// that ended while the page was closed or reloading is taken in on the next
// load, and only once. The server keeps a finished run for a few minutes.
const SEEN_JOBS_KEY = "zipify.seenJobs.v1";
const MAX_SEEN_JOBS = 200;

// the server names a "Download selected" run "<playlist> (picked)"
const PICKED_SUFFIX = " (picked)";

// the seen runs; null when this browser hasn't kept track yet (or can't)
function readSeenJobs() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEEN_JOBS_KEY));
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : null;
  } catch (e) {
    return null;
  }
}

function rememberSeenJobs(ids) {
  const seen = (readSeenJobs() ?? []).filter((id) => !ids.includes(id));
  try {
    localStorage.setItem(SEEN_JOBS_KEY, JSON.stringify([...seen, ...ids].slice(-MAX_SEEN_JOBS)));
  } catch (e) {
    // blocked storage: then every load starts afresh, and takes no ended run in
  }
}

// GET /jobs: the server's runs, newest first. An older server has no such
// list (404), and then there's nothing to pick up.
async function fetchJobs() {
  try {
    const res = await fetch("/jobs");
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    return jobs.filter((job) => typeof job?.id === "string" && job.id !== "" && typeof job.status === "string");
  } catch (e) {
    return []; // the server isn't there: nothing to pick up
  }
}

// On load: a run still going on the server (the page was reloaded, or
// closed and opened again) is followed again like a run started here, with
// its countdown, controls and charts; runs that ended unseen meanwhile are
// taken in. The first load that keeps track takes the runs already ended
// as seen: an older page took those in already.
async function pickUpRuns() {
  const jobs = await fetchJobs();
  // the newest run going is followed (unless one was started here meanwhile)
  const running = jobs.filter((job) => job.status === "running");
  const isFollowing = running.length > 0 && !isBatchRunning;
  if (isFollowing) followAgain(running[0]);
  for (const job of isFollowing ? running.slice(1) : running) {
    log(`${job.name} is also still downloading on the server; reload this page once it's done to see how it went.`, "warn");
  }

  const ended = jobs.filter((job) => job.status !== "running");
  const seen = readSeenJobs();
  if (seen == null) {
    rememberSeenJobs(ended.map((job) => job.id));
    return;
  }
  // oldest first, the order they ended in
  for (const job of ended.filter((job) => !seen.includes(job.id)).reverse()) await takeInEndedJob(job);
}

// a "Download selected" run's songs belong to the playlist it was picked from
function playlistNameOf(job) {
  const name = String(job.name ?? "");
  return job.isPicks && name.endsWith(PICKED_SUFFIX) ? name.slice(0, -PICKED_SUFFIX.length) : name;
}

// A run still going on the server, followed as a batch of its own: it ends
// like any other (log, review list, alert), and Pause, Stop and the live
// control work on it.
function followAgain(listed) {
  const name = String(listed.name ?? "Playlist");
  const entry = batchEntry({
    name,
    playlistName: playlistNameOf(listed),
    isPicks: listed.isPicks === true,
    startJob: async () => {
      log(`Reconnected to ${name}`);
      return listed.id;
    },
  });
  batch = [entry];
  runBatch(batch, readOptions());
}

// A run that ended while this page wasn't following it: its outcome goes in
// the log, its songs to review join the list (and the songs it settled
// leave it), and a ZIP it made is fetched, as if the page had been there.
async function takeInEndedJob(listed) {
  let job = null;
  try {
    // only the outcome: none of its ✓ / ✗ lines
    const res = await fetch(`/progress?job=${encodeURIComponent(listed.id)}&after=${Number.MAX_SAFE_INTEGER}`);
    if (res.ok) job = await res.json();
  } catch (e) {
    job = null; // gone meanwhile, or the server went away: nothing to take in
  }
  if (!job || job.status === "running") return;

  rememberSeenJobs([listed.id]);
  const name = String(job.name ?? listed.name ?? "Playlist");
  if (job.status === "error") log(`${name}: ${job.error || "the run failed"} (while this page was closed)`, "warn");
  else log(`${name}: ${countsText(job)} (finished while this page was closed)`, "ok");

  const fields = { playlistName: playlistNameOf({ ...listed, name }), isPicks: listed.isPicks === true };
  addReviews(job.reviews, playlistOfJob(job, fields), settledSongsOf(job));
  if (job.status === "ready") {
    log(`Saving "${name}.zip": watch your browser's downloads.`);
    downloadZip(job.id);
  }
}

// Leaving or reloading doesn't stop a run on the server (the page picks it
// up again when it loads), but the playlists still waiting in this batch
// would never start: the browser asks first then.
function warnBeforeLeaving(event) {
  if (!batch.some((item) => item.status === "waiting")) return;
  event.preventDefault();
  event.returnValue = "";
}

// --- YouTube sign-in: remembered on this browser, suggested on the bot check ---

const COOKIES_BROWSER_KEY = "zipify.cookiesBrowser";
let hasSuggestedSignIn = false;

// YouTube's "confirm you're not a bot" wall: point to the sign-in setting once
function suggestSignInOnBotCheck(text) {
  if (hasSuggestedSignIn || $("cookiesBrowser").value || !/not a bot/i.test(text)) return;
  hasSuggestedSignIn = true;
  log(
    "Tip: YouTube is asking to confirm you're not a bot. Pick your browser under " +
      "\"YouTube sign-in\" and download the review list again.",
    "warn"
  );
}

// a convenience only: the page works the same when storage is unavailable
function rememberCookiesBrowser() {
  try {
    localStorage.setItem(COOKIES_BROWSER_KEY, $("cookiesBrowser").value);
  } catch (e) {
    // private window or blocked storage: nothing to remember then
  }
}

function restoreCookiesBrowser() {
  try {
    const saved = localStorage.getItem(COOKIES_BROWSER_KEY);
    if (saved && [...$("cookiesBrowser").options].some((o) => o.value === saved)) {
      $("cookiesBrowser").value = saved;
    }
  } catch (e) {
    // private window or blocked storage: keep the default ("Don't use")
  }
}

// --- Extras: remembered on this browser, sent with every run ---

// The checkboxes the server takes, by id and field name: "1"/"0" on /upload,
// true/false on /picks (which ignores reuseSongs). notifyDone stays here.
const SERVER_EXTRAS = ["keepAwake", "numberTracks", "writePlaylist", "reuseSongs", "autoRetry"];
const EXTRA_IDS = [...SERVER_EXTRAS, "notifyDone"];
const EXTRAS_KEY = "zipify.extras";

function readExtras() {
  return Object.fromEntries(SERVER_EXTRAS.map((id) => [id, $(id).checked === true]));
}

// a convenience only: without storage the boxes start as the page sets them
function rememberExtras() {
  try {
    const saved = Object.fromEntries(EXTRA_IDS.map((id) => [id, $(id).checked === true]));
    localStorage.setItem(EXTRAS_KEY, JSON.stringify(saved));
  } catch (e) {
    // private window or blocked storage: nothing to remember then
  }
}

function restoreExtras() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXTRAS_KEY) ?? "{}");
    for (const id of EXTRA_IDS) {
      if (typeof saved?.[id] === "boolean") $(id).checked = saved[id];
    }
  } catch (e) {
    // private window, blocked storage or a broken entry: keep the page's defaults
  }
}

// --- the finish alert: a desktop notification, a chime and the tab title ---

const ALERT_TITLE = "ZipifyTunes";
const DONE_TITLE_PREFIX = "✓ ";

// two rising notes as a playlist ends, three as a whole batch does
const CHIME_NOTES_HZ = [659.25, 783.99, 1046.5]; // E5 G5 C6
const PLAYLIST_CHIME_NOTES = 2;
const BATCH_CHIME_NOTES = 3;
const CHIME_NOTE_GAP_S = 0.14;
const CHIME_NOTE_S = 0.7;
const CHIME_ATTACK_S = 0.015;
const CHIME_VOLUME = 0.12;
const SILENT_GAIN = 0.0001; // the fades are exponential, so they can't reach 0

let audioContext = null;
let chimeFreeAt = 0; // a chime asked for while another plays starts after it

function isNotifyOn() {
  return $("notifyDone").checked === true;
}

// On the Download click: browsers only ask about notifications, and Safari
// only lets sound start, in answer to a click.
function prepareFinishAlert() {
  if (!isNotifyOn()) return;
  askNotificationPermission();
  startAudio();
}

function askNotificationPermission() {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    Promise.resolve(Notification.requestPermission()).catch(() => {});
  } catch (e) {
    // no notifications then: the chime and the tab title still tell
  }
}

// the page's one AudioContext, woken if it can be; null when there's no sound
function startAudio() {
  try {
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext ??= new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    return audioContext;
  } catch (e) {
    return null;
  }
}

function playChime(noteCount) {
  const context = startAudio();
  if (!context) return;
  try {
    const start = Math.max(context.currentTime + 0.05, chimeFreeAt);
    const notes = CHIME_NOTES_HZ.slice(-noteCount);
    notes.forEach((hz, i) => playNote(context, hz, start + i * CHIME_NOTE_GAP_S));
    chimeFreeAt = start + (notes.length - 1) * CHIME_NOTE_GAP_S + CHIME_NOTE_S;
  } catch (e) {
    // the sound device went away: the notification and the title still tell
  }
}

// one soft bell-like note: a quick swell, then a long fade
function playNote(context, hz, at) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(hz, at);
  gain.gain.setValueAtTime(SILENT_GAIN, at);
  gain.gain.exponentialRampToValueAtTime(CHIME_VOLUME, at + CHIME_ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, at + CHIME_NOTE_S);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + CHIME_NOTE_S);
}

function showNotification(title, body) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (e) {
    // e.g. a browser that only notifies from a service worker: chime and title only
  }
}

// "✓ ZipifyTunes" in the tab until the window is looked at again; nothing
// while it's being looked at
function markTitleDone() {
  if (document.hasFocus() || document.title.startsWith(DONE_TITLE_PREFIX)) return;
  document.title = DONE_TITLE_PREFIX + document.title;
  window.addEventListener("focus", clearTitleDone, { once: true });
}

function clearTitleDone() {
  if (document.title.startsWith(DONE_TITLE_PREFIX)) {
    document.title = document.title.slice(DONE_TITLE_PREFIX.length);
  }
}

function sendFinishAlert(title, body, chimeNotes) {
  if (!isNotifyOn()) return; // read now: unticking it mid-run silences it
  showNotification(title, body);
  playChime(chimeNotes);
  try {
    markTitleDone();
  } catch (e) {
    // the title is a nicety: never let it break the batch
  }
}

// What the alert says once a playlist has ended (see finishPlaylist):
// { title: "ZipifyTunes — Road trip", body: "12 saved, 3 to review" }, or
// "Stopped: …" / "Failed: <why>"
function playlistAlertText(item, job) {
  const title = `${ALERT_TITLE} — ${item.name}`;
  if (!job || item.status === "failed") {
    return { title, body: `Failed: ${item.summary || "the run didn't finish"}` };
  }
  const { saved, toReview } = countsOf(job);
  const tally = `${saved} saved, ${toReview} to review`;
  return { title, body: item.status === "stopped" ? `Stopped: ${tally}` : tally };
}

function alertPlaylistEnd(item, job) {
  const { title, body } = playlistAlertText(item, job);
  sendFinishAlert(title, body, PLAYLIST_CHIME_NOTES);
}

function alertBatchEnd(entries) {
  sendFinishAlert(`${ALERT_TITLE} — batch finished`, batchSummaryText(entries), BATCH_CHIME_NOTES);
}

$("startButton").addEventListener("click", startBatch);
$("cookiesBrowser").addEventListener("change", rememberCookiesBrowser);
for (const id of EXTRA_IDS) $(id).addEventListener("change", rememberExtras);
// ticking it is a click too: ask right away rather than at the next Download
$("notifyDone").addEventListener("change", prepareFinishAlert);
$("chooseFolder").addEventListener("click", chooseFolder);
$("pauseButton").addEventListener("click", togglePause);
$("stopButton").addEventListener("click", stopRun);
$("saveTo").addEventListener("focus", loadDrives);
$("parallel").addEventListener("change", readParallel);
$("parallelDown").addEventListener("click", () => changeParallel(shownParallel() - 1));
$("parallelUp").addEventListener("click", () => changeParallel(shownParallel() + 1));
$("parallelSlider").addEventListener("input", () => changeParallel($("parallelSlider").value));
$("reviewSelectAll").addEventListener("change", (event) => selectAllReview(event.target.checked));
$("reviewDownload").addEventListener("click", downloadSelected);
$("reviewClear").addEventListener("click", clearReviewList);
window.addEventListener("beforeunload", warnBeforeLeaving);
watchChartReading();
restoreCookiesBrowser();
restoreExtras();
restoreReviewList();
loadDrives();
pickUpRuns();
