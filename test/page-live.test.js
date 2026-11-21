const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// The page driven end to end: charts.js and app.js run in a vm against a
// small stand-in DOM, timers on a virtual clock, a fake server answering
// fetch, and an in-memory localStorage. Each test loads its own page.

const ROOT = path.join(__dirname, '..')
const START_MS = 1_700_000_000_000

const REVIEW_LIST_KEY = 'zipify.reviewList.v1'
const SEEN_JOBS_KEY = 'zipify.seenJobs.v1'

// --- the stand-in DOM ---

class FakeText {
  constructor (text) {
    this.parent = null
    this.textContent = String(text)
  }
}

class FakeElement {
  constructor (owner, tagName, id = null) {
    this.owner = owner
    this.tagName = tagName.toUpperCase()
    this.id = id
    this.className = ''
    this.parent = null
    this.childNodes = []
    this.attributes = {}
    this.dataset = {}
    this.style = {}
    this.listeners = {}
    this.value = ''
    this.disabled = false
    this.checked = false
    this.options = []
    this.files = []
    this.scrollTop = 0
    this.scrollHeight = 0
    const element = this
    this.classList = {
      add: (...names) => {
        element.className = [...new Set([...element.classNames(), ...names])].join(' ')
      },
      remove: (...names) => {
        element.className = element.classNames().filter((name) => !names.includes(name)).join(' ')
      },
      toggle (name, force) {
        const isOn = force === undefined ? !element.classNames().includes(name) : Boolean(force)
        if (isOn) this.add(name)
        else this.remove(name)
        return isOn
      },
      contains: (name) => element.classNames().includes(name)
    }
  }

  classNames () {
    return String(this.className).split(/\s+/).filter(Boolean)
  }

  get children () {
    return this.childNodes.filter((node) => node instanceof FakeElement)
  }

  get textContent () {
    return this.childNodes.map((node) => node.textContent).join('')
  }

  set textContent (text) {
    this.adopt([new FakeText(text)])
  }

  adopt (nodes) {
    for (const node of this.childNodes) node.parent = null
    const adopted = nodes.map((node) => (typeof node === 'string' ? new FakeText(node) : node))
    for (const node of adopted) {
      if (node.parent && node.parent !== this) {
        node.parent.childNodes = node.parent.childNodes.filter((other) => other !== node)
      }
      node.parent = this
    }
    this.childNodes = adopted
  }

  append (...nodes) {
    this.adopt([...this.childNodes.filter((node) => !nodes.includes(node)), ...nodes])
  }

  replaceChildren (...nodes) {
    this.adopt(nodes)
  }

  replaceWith (node) {
    const parent = this.parent
    if (!parent) return
    parent.adopt(parent.childNodes.map((child) => (child === this ? node : child)))
  }

  remove () {
    if (!this.parent) return
    this.parent.childNodes = this.parent.childNodes.filter((node) => node !== this)
    this.parent = null
  }

  setAttribute (name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute (name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
  }

  removeAttribute (name) {
    delete this.attributes[name]
  }

  addEventListener (type, listener) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener]
  }

  removeEventListener () {}

  dispatch (type, event = {}) {
    for (const listener of this.listeners[type] ?? []) listener({ target: this, preventDefault () {}, ...event })
  }

  focus () {
    this.owner.activeElement = this
  }

  click () {
    this.owner.clicked.push(this)
  }

  contains (other) {
    for (let node = other; node; node = node.parent) if (node === this) return true
    return false
  }

  descendants () {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }

  querySelector (selector) {
    return this.descendants().find((node) => matches(node, selector)) ?? null
  }

  getBoundingClientRect () {
    return { left: 0, top: 0, width: 260, height: 156 }
  }
}

// ".name", "tag[data-x=\"v\"]" and "[data-x=\"v\"]": all the page asks for
function matches (node, selector) {
  const match = /^([a-z]*)(?:\.([\w-]+))?(?:\[data-([\w-]+)="([^"]*)"\])?$/i.exec(selector)
  if (!match) throw new Error(`selector not supported in tests: ${selector}`)
  const [, tag, className, dataName, dataValue] = match
  if (tag && node.tagName !== tag.toUpperCase()) return false
  if (className && !node.classList.contains(className)) return false
  if (dataName && node.dataset[dataName] !== dataValue) return false
  return true
}

// --- the fake server ---

function response (status, body) {
  const text = JSON.stringify(body ?? null)
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) }
}

// Routes match by method and URL prefix; one added later wins. An answer
// with `delayMs` arrives that much later on the page's clock.
function createServer () {
  const routes = []
  const requests = []
  return {
    requests,
    sleep: null, // set by loadPage: a wait on the page's virtual clock
    on (method, prefix, handler) {
      routes.unshift({ method, prefix, handler })
    },
    async fetch (url, init = {}) {
      const request = { method: (init.method ?? 'GET').toUpperCase(), url: String(url), body: init.body }
      requests.push(request)
      const route = routes.find((r) => r.method === request.method && request.url.startsWith(r.prefix))
      if (!route) return response(404, { error: 'Not found' })
      const answer = route.handler(request)
      if (answer.delayMs) await this.sleep(answer.delayMs)
      return response(answer.status ?? 200, answer.body)
    }
  }
}

function jobParam (url) {
  return new URL(url, 'http://page.test').searchParams.get('job')
}

// a job as GET /progress shows it (see publicJob in server.js)
function snapshot (job) {
  const isRunning = job.status === 'running'
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    done: job.done,
    error: job.error ?? null,
    saveFolder: job.saveFolder ?? '/Music/Road trip',
    name: job.name,
    parallel: job.parallel ?? 3,
    control: job.control ?? 'run',
    active: job.active ?? [],
    activeCount: (job.active ?? []).length,
    savedCount: job.savedCount ?? 0,
    skippedCount: job.skippedCount ?? 0,
    reusedCount: 0,
    savedBytes: 0,
    elapsedMs: 5000,
    etaMs: job.etaMs ?? null,
    events: [],
    history: [],
    recent: job.recent ?? [],
    reviewCount: (job.reviews ?? []).length,
    ...(isRunning ? {} : { reviews: job.reviews ?? [] })
  }
}

// a job as GET /jobs lists it
function listed (job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    total: job.total,
    done: job.done,
    saveFolder: job.saveFolder ?? '/Music/Road trip',
    startedAt: START_MS - 60_000,
    endedAt: job.status === 'running' ? null : START_MS - 1000,
    isPicks: job.isPicks ?? false
  }
}

function serveJobs (server, jobs) {
  server.on('GET', '/jobs', () => ({ body: { jobs: jobs.map(listed) } }))
  server.on('GET', '/progress', (request) => {
    const job = jobs.find((candidate) => candidate.id === jobParam(request.url))
    return job ? { body: snapshot(job) } : { status: 404, body: { error: 'Unknown job' } }
  })
  for (const job of jobs) {
    for (const action of ['pause', 'resume', 'stop']) {
      server.on('POST', `/jobs/${job.id}/${action}`, () => {
        job.control = { pause: 'pause', resume: 'run', stop: 'stop' }[action]
        return { body: snapshot(job) }
      })
    }
    server.on('POST', `/jobs/${job.id}/parallel`, (request) => {
      job.parallel = JSON.parse(request.body).parallel
      return { body: snapshot(job) }
    })
  }
}

// --- the page ---

function loadPage ({ server = createServer(), storage = new Map() } = {}) {
  const clock = { now: START_MS }
  const timers = new Map()
  let lastTimerId = 0
  const setTimeoutV = (fn, ms = 0, ...args) => {
    lastTimerId += 1
    timers.set(lastTimerId, { at: clock.now + Math.max(0, Number(ms) || 0), fn: () => fn(...args) })
    return lastTimerId
  }
  const clearTimeoutV = (id) => timers.delete(id)
  server.sleep = (ms) => new Promise((resolve) => setTimeoutV(resolve, ms))

  async function flush () {
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve))
  }

  // run every timer due within `ms`, in order, letting promises settle between them
  async function advance (ms) {
    const target = clock.now + ms
    for (;;) {
      await flush()
      let next = null
      for (const [id, timer] of timers) {
        if (timer.at <= target && (!next || timer.at < next[1].at)) next = [id, timer]
      }
      if (!next) break
      timers.delete(next[0])
      clock.now = next[1].at
      next[1].fn()
    }
    clock.now = target
    await flush()
  }

  class FakeDate extends Date {
    constructor (...args) {
      if (args.length === 0) super(clock.now)
      else super(...args)
    }

    static now () {
      return clock.now
    }
  }

  const owner = { activeElement: null, clicked: [] }
  const elements = new Map()
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(owner, 'div', id))
    return elements.get(id)
  }
  // index.html's starting state, as far as the tests look at it
  for (const id of ['runPanel', 'statsPanel', 'batchPanel', 'reviewPanel']) el(id).className = 'card hidden'
  el('awakeBadge').className = 'awake-badge hidden'
  el('parallel').value = '3'
  el('parallelSlider').value = '3'
  el('quality').value = '0'

  const document = {
    getElementById: el,
    createElement: (tag) => new FakeElement(owner, tag),
    createElementNS: (namespace, tag) => new FakeElement(owner, tag),
    querySelector: (selector) => {
      for (const element of elements.values()) {
        if (matches(element, selector)) return element
        const found = element.querySelector(selector)
        if (found) return found
      }
      return null
    },
    hasFocus: () => true,
    body: new FakeElement(owner, 'body'),
    get activeElement () {
      return owner.activeElement
    },
    title: 'ZipifyTunes'
  }

  const windowListeners = {}
  const confirms = []
  const page = {
    document,
    fetch: (url, init) => server.fetch(url, init),
    setTimeout: setTimeoutV,
    clearTimeout: clearTimeoutV,
    setInterval: setTimeoutV,
    clearInterval: clearTimeoutV,
    Date: FakeDate,
    console,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    confirm: (message) => {
      confirms.push(message)
      return harness.confirmAnswer
    },
    alert: () => {},
    addEventListener: (type, listener) => {
      windowListeners[type] = [...(windowListeners[type] ?? []), listener]
    },
    removeEventListener () {}
  }
  page.window = page
  vm.createContext(page)
  for (const file of ['charts.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), page, { filename: file })
  }

  const harness = {
    page,
    el,
    owner,
    server,
    storage,
    confirms,
    windowListeners,
    confirmAnswer: true,
    advance,
    // a top-level `let` of app.js (those aren't properties of the page's global object)
    read: (name) => vm.runInContext(name, page),
    logLines: () => el('statusBox').children.map((line) => line.textContent),
    saved: (key) => JSON.parse(storage.get(key) ?? 'null')
  }
  return harness
}

// --- songs and reviews ---

const PLAYLIST = { name: 'Road trip', saveFolder: '/Music/Road trip', trackTotal: 40 }

function candidate (videoId, label = 'Good match', score = 0.9) {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: `Upload ${videoId}`,
    channel: 'Channel',
    durationSec: 200,
    views: 1000,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    score,
    label,
    variant: []
  }
}

function review (number, title, artist, candidates, reason = 'No exact match on YouTube') {
  return { number, title, artist, album: 'Album', year: '2020', genre: 'Pop', durationSec: 200, reason, candidates }
}

const BABYDOLL = review(5, 'Babydoll', 'Jamie Miller', [candidate('babydoll001'), candidate('babydoll002', 'Possible', 0.6)])
const OTHER_SONG = review(9, 'Other Song', 'Band', [candidate('othersong01', 'Possible', 0.7)])

// The list's rows as plain objects of this realm (the page's arrays and
// objects come from the vm's, which deepStrictEqual tells apart)
function rows (h) {
  return [...h.read('reviewItems')].map((item) => ({
    key: item.key,
    title: item.song.title,
    chosenId: item.chosenId,
    isSelected: item.isSelected,
    reason: item.reason,
    candidates: [...item.candidates].map((c) => c.videoId)
  }))
}

// --- picking a run up again after a reload ---

test('a run still going on the server when the page loads is followed again, with its controls', async () => {
  const server = createServer()
  const job = { id: 'job-1', name: 'Road trip', status: 'running', total: 10, done: 2, parallel: 4, etaMs: 60_000 }
  serveJobs(server, [job])
  const h = loadPage({ server })

  await h.advance(1100) // the run's first poll

  assert.ok(h.logLines().includes('Reconnected to Road trip'), h.logLines().join('\n'))
  assert.equal(h.el('runPanel').classList.contains('hidden'), false)
  assert.equal(h.el('runName').textContent, 'Road trip')
  assert.equal(h.el('parallelValue').textContent, '4')
  assert.equal(h.el('parallelSlider').disabled, false)
  assert.equal(h.el('stopButton').disabled, false)
  assert.equal(h.el('progressText').textContent, '2 / 10 songs (20%)')

  h.page.stopRun()
  await h.advance(10)

  assert.ok(server.requests.some((r) => r.method === 'POST' && r.url === '/jobs/job-1/stop'))
})

test('a run picked up again lists its songs to review once it ends, and is not taken in twice', async () => {
  const server = createServer()
  const job = { id: 'job-1', name: 'Road trip', status: 'running', total: 10, done: 2 }
  serveJobs(server, [job])
  const storage = new Map()
  const h = loadPage({ server, storage })
  await h.advance(1100)

  Object.assign(job, { status: 'saved', done: 10, savedCount: 9, reviews: [OTHER_SONG] })
  await h.advance(1100)

  assert.deepEqual(rows(h).map((row) => row.title), ['Other Song'])
  assert.ok(h.saved(SEEN_JOBS_KEY).includes('job-1'))

  // the next load finds it ended, and seen
  const requestsBefore = server.requests.length
  const again = loadPage({ server, storage })
  await again.advance(100)

  assert.deepEqual(server.requests.slice(requestsBefore).map((r) => r.url), ['/drives', '/jobs'])
  assert.deepEqual(rows(again).map((row) => row.title), ['Other Song'])
  assert.ok(!again.logLines().some((line) => line.includes('finished while this page was closed')))
})

test('an older server without GET /jobs leaves the page as it was', async () => {
  const h = loadPage()

  await h.advance(1100)

  assert.equal(h.el('runPanel').classList.contains('hidden'), true)
  assert.deepEqual(h.logLines(), [])
})

test('a run that ended while the page was away has its songs put on the review list, once', async () => {
  const server = createServer()
  const ended = { id: 'new-job', name: 'Road trip', status: 'saved', total: 40, done: 40, savedCount: 39, reviews: [BABYDOLL] }
  const seen = { id: 'old-job', name: 'Gym', status: 'saved', total: 5, done: 5, reviews: [OTHER_SONG] }
  serveJobs(server, [ended, seen])
  const storage = new Map([[SEEN_JOBS_KEY, JSON.stringify(['old-job'])]])
  const h = loadPage({ server, storage })

  await h.advance(100)

  assert.deepEqual(rows(h).map((row) => row.title), ['Babydoll'])
  assert.equal(h.read('reviewItems')[0].playlist.trackTotal, 40)
  assert.ok(h.logLines().some((line) => line.startsWith('Road trip: 39 saved')), h.logLines().join('\n'))
  assert.ok(!server.requests.some((r) => r.url.startsWith('/progress?job=old-job')))
  assert.deepEqual(h.saved(SEEN_JOBS_KEY).sort(), ['new-job', 'old-job'])
})

test('a ZIP that was made while the page was away is fetched', async () => {
  const server = createServer()
  serveJobs(server, [{ id: 'zip-job', name: 'Road trip', status: 'ready', total: 3, done: 3, savedCount: 3, saveFolder: null }])
  const h = loadPage({ server, storage: new Map([[SEEN_JOBS_KEY, '[]']]) })

  await h.advance(100)

  assert.deepEqual(h.owner.clicked.map((link) => link.href), ['/download/zip-job'])
})

test('the first load that keeps track takes runs that already ended as seen, not as new', async () => {
  const server = createServer()
  serveJobs(server, [{ id: 'j1', name: 'Road trip', status: 'saved', total: 3, done: 3, reviews: [BABYDOLL] }])
  const storage = new Map()
  const h = loadPage({ server, storage })

  await h.advance(100)

  assert.deepEqual(rows(h), [])
  assert.deepEqual(h.saved(SEEN_JOBS_KEY), ['j1'])
  assert.ok(!server.requests.some((r) => r.url.startsWith('/progress')))
})

// --- the review list, kept on this browser ---

test('the review list, with its picks and ticks, survives a reload', async () => {
  const storage = new Map()
  const h = loadPage({ storage })
  h.page.addReviews([BABYDOLL, OTHER_SONG], PLAYLIST)
  const [babydoll, other] = h.read('reviewItems')
  h.page.updateReviewItem(babydoll.key, { chosenId: 'babydoll002', isSelected: false })
  h.page.updateReviewItem(other.key, { isSelected: true })

  const again = loadPage({ storage })

  assert.deepEqual(
    rows(again).map(({ key, ...row }) => row),
    [
      { title: 'Babydoll', chosenId: 'babydoll002', isSelected: false, reason: 'No exact match on YouTube', candidates: ['babydoll001', 'babydoll002'] },
      { title: 'Other Song', chosenId: 'othersong01', isSelected: true, reason: 'No exact match on YouTube', candidates: ['othersong01'] }
    ]
  )
  assert.deepEqual({ ...again.read('reviewItems')[0].playlist }, PLAYLIST)
  assert.equal(again.el('reviewPanel').classList.contains('hidden'), false)
})

test('a broken saved list is left out rather than breaking the page', () => {
  const storage = new Map([[REVIEW_LIST_KEY, JSON.stringify([{ playlist: null }, 'junk', {
    playlist: PLAYLIST,
    song: { title: 'Kept', artist: 'Band' },
    reason: 'No exact match on YouTube',
    candidates: [candidate('keptsong001'), { videoId: 'not an id' }],
    chosenId: 'gone0000000',
    isSelected: true
  }])]])

  const h = loadPage({ storage })

  assert.deepEqual(rows(h).map(({ key, ...row }) => row), [
    { title: 'Kept', chosenId: 'keptsong001', isSelected: true, reason: 'No exact match on YouTube', candidates: ['keptsong001'] }
  ])
})

test('Clear list empties the list and its saved copy, once confirmed', () => {
  const storage = new Map()
  const h = loadPage({ storage })
  h.page.addReviews([BABYDOLL, OTHER_SONG], PLAYLIST)

  h.confirmAnswer = false
  h.page.clearReviewList()
  assert.equal(h.read('reviewItems').length, 2)

  h.confirmAnswer = true
  h.page.clearReviewList()

  assert.equal(h.read('reviewItems').length, 0)
  assert.equal(storage.has(REVIEW_LIST_KEY), false)
  assert.equal(h.el('reviewPanel').classList.contains('hidden'), true)
  assert.match(h.confirms.at(-1), /2 songs/)
})

// --- what a later run of the same playlist does to the list ---

function runOnce (h, server, job, { polls = [] } = {}) {
  serveJobs(server, [job])
  const entry = h.page.batchEntry({ name: job.name, playlistName: job.name, startJob: async () => job.id })
  const done = h.page.runBatch([entry], h.page.readOptions())
  return { entry, done, polls }
}

test('a later run of the playlist that saved a listed song takes its row off the list', async () => {
  const server = createServer()
  const h = loadPage({ server })
  h.page.addReviews([BABYDOLL, OTHER_SONG], PLAYLIST)
  const otherKey = h.read('reviewItems')[1].key
  const job = {
    id: 'run-2',
    name: 'Road trip',
    status: 'running',
    total: 40,
    done: 1,
    recent: [{ number: 5, title: 'Babydoll', artist: 'Jamie Miller', outcome: 'saved', reason: null }]
  }
  const { done } = runOnce(h, server, job)
  await h.advance(1100)

  // later polls no longer list it among the songs that finished last
  Object.assign(job, { status: 'saved', done: 40, savedCount: 39, recent: [], reviews: [OTHER_SONG] })
  await h.advance(1100)
  await done

  assert.deepEqual(rows(h).map((row) => [row.key, row.title]), [[otherKey, 'Other Song']])
})

test('a run whose list of settled songs the server sends drops their rows, even with nothing to review', async () => {
  const server = createServer()
  const h = loadPage({ server })
  h.page.addReviews([BABYDOLL, OTHER_SONG], PLAYLIST)
  const job = {
    id: 'run-2',
    name: 'Road trip',
    status: 'saved',
    total: 40,
    done: 40,
    savedCount: 40,
    reviews: []
  }
  serveJobs(server, [job])
  server.on('GET', '/progress', () => ({ body: { ...snapshot(job), settled: [{ number: 9, title: 'other song', artist: 'BAND' }] } }))
  const entry = h.page.batchEntry({ name: job.name, playlistName: job.name, startJob: async () => job.id })
  const done = h.page.runBatch([entry], h.page.readOptions())
  await h.advance(1100)
  await done

  assert.deepEqual(rows(h).map((row) => row.title), ['Babydoll'])
})

test('a song listed again keeps its row, pick and tick, and takes the new reason and uploads', () => {
  const h = loadPage()
  h.page.addReviews([BABYDOLL], PLAYLIST)
  const [row] = h.read('reviewItems')
  h.page.updateReviewItem(row.key, { chosenId: 'babydoll002', isSelected: true })

  const failed = review(5, 'BABYDOLL', 'jamie miller', [candidate('babydoll001'), candidate('babydoll003', 'Possible', 0.5)], 'Download failed: HTTP Error 403')
  h.page.addReviews([failed], PLAYLIST)

  assert.deepEqual(rows(h), [{
    key: row.key,
    title: 'Babydoll',
    chosenId: 'babydoll002',
    isSelected: true,
    reason: 'Download failed: HTTP Error 403',
    candidates: ['babydoll001', 'babydoll002', 'babydoll003']
  }])
})

test('a song listed twice in one run gets one row', () => {
  const h = loadPage()

  h.page.addReviews([BABYDOLL, { ...BABYDOLL, number: 31 }], PLAYLIST)

  assert.deepEqual(rows(h).map((row) => row.title), ['Babydoll'])
})

test('titles with the same accents, written either way, are the same song', () => {
  const h = loadPage()
  const composed = review(1, 'Beyoncé', 'Artist', [candidate('beyonce0001')])
  const decomposed = review(1, 'Beyoncé', 'Artist', [candidate('beyonce0002')])

  h.page.addReviews([composed], PLAYLIST)
  h.page.addReviews([decomposed], PLAYLIST)

  assert.equal(h.read('reviewItems').length, 1)
})

// --- Stop, and the live "Downloading at once" control ---

test('Stop drops a change to how many download at once that was not sent yet', async () => {
  const server = createServer()
  const h = loadPage({ server })
  const job = { id: 'job-1', name: 'Road trip', status: 'running', total: 10, done: 2, parallel: 6 }
  const { done } = runOnce(h, server, job)
  // a busy server: Stop's answer comes after the wait for a settled number
  server.on('POST', '/jobs/job-1/stop', () => {
    job.control = 'stop'
    return { body: snapshot(job), delayMs: 500 }
  })
  await h.advance(1100)

  h.page.changeParallel(2)
  h.page.stopRun() // within the wait for the person to settle on a number
  await h.advance(400)

  assert.equal(h.el('parallelSlider').disabled, true, 'the control locks at the click')
  await h.advance(600)

  assert.ok(!server.requests.some((r) => r.url === '/jobs/job-1/parallel'))
  assert.ok(!h.logLines().some((line) => line.startsWith('Now downloading')))
  assert.equal(h.el('parallelSlider').disabled, true)
  assert.equal(h.el('parallelValue').textContent, '6')
  job.status = 'saved'
  await h.advance(1100)
  await done
})

test('the − and + buttons are off at 1 and at 20, where they could do nothing', () => {
  const h = loadPage()

  h.page.renderParallelControl(1, true)
  assert.equal(h.el('parallelDown').disabled, true)
  assert.equal(h.el('parallelUp').disabled, false)

  h.page.renderParallelControl(20, true)
  assert.equal(h.el('parallelDown').disabled, false)
  assert.equal(h.el('parallelUp').disabled, true)

  h.page.renderParallelControl(5, false)
  assert.equal(h.el('parallelDown').disabled, true)
  assert.equal(h.el('parallelUp').disabled, true)
})

test('a button switched off under keyboard focus hands the focus to the slider', () => {
  const h = loadPage()
  h.page.renderParallelControl(2, true)
  h.el('parallelDown').focus()

  h.page.renderParallelControl(1, true)

  assert.equal(h.owner.activeElement, h.el('parallelSlider'))
})

// --- the songs being worked on ---

function song (number, phase, extra = {}) {
  return { number, title: `Song ${number}`, artist: 'Band', phase, ...extra }
}

test('the songs being worked on keep their rows from poll to poll; only what changed is updated', () => {
  const h = loadPage()
  h.page.renderActiveSongs({ active: [song(3, 'downloading', { downloadedBytes: 1, totalBytes: 4 }), song(4, 'searching')] })
  const [row3, row4] = h.el('activeSongs').children

  h.page.renderActiveSongs({ active: [song(3, 'downloading', { downloadedBytes: 3, totalBytes: 4 }), song(4, 'converting')] })
  const [again3, again4] = h.el('activeSongs').children

  assert.equal(again3, row3)
  assert.equal(again4, row4)
  assert.equal(row4.dataset.phase, 'converting')
  assert.match(row3.textContent, /75%/)

  h.page.renderActiveSongs({ active: [song(4, 'tagging'), song(7, 'searching')] })
  const [still4, row7] = h.el('activeSongs').children

  assert.equal(still4, row4)
  assert.equal(h.el('activeSongs').children.length, 2)
  assert.match(row7.textContent, /^7\. Song 7/)
})

// --- how a run ends ---

test('a run stopped before any song was saved reads as stopped, not failed', () => {
  const h = loadPage()
  const item = h.page.batchEntry({ name: 'Road trip', playlistName: 'Road trip', startJob: async () => null })
  h.page.resetRunPanel('Road trip', 3)

  h.page.reportOutcome(item, {
    id: 'job-1',
    status: 'error',
    control: 'stop',
    error: 'Stopped before any song was saved.',
    total: 3,
    done: 0,
    savedCount: 0
  })

  assert.equal(h.el('countdown').dataset.state, 'stopped')
  assert.equal(h.el('countdownValue').textContent, 'Stopped')
  assert.equal(h.el('countdownNote').textContent, 'nothing was saved')
  assert.equal(h.el('progress').dataset.state, 'stopped')
  assert.equal(item.status, 'stopped')
  h.page.stopCountdown()
})

test('leaving the page asks first while playlists of the batch are still waiting to start', () => {
  const h = loadPage()
  const [warn] = h.windowListeners.beforeunload
  let asked = 0
  const event = { preventDefault: () => { asked += 1 }, returnValue: undefined }

  warn(event)
  assert.equal(asked, 0)

  vm.runInContext('batch = [batchEntry({ name: "Gym", playlistName: "Gym", startJob: async () => null })]', h.page)
  warn(event)
  assert.equal(asked, 1)
})
