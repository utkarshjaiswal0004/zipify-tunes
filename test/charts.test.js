const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// charts.js draws through document.createElementNS. This stands in for the
// little of the DOM it may use, so the tests can look at what it drew (and
// fail loudly if it reaches for anything else, like innerHTML).
const SVG_NS = 'http://www.w3.org/2000/svg'

class FakeElement {
  constructor (tagName) {
    this.tagName = tagName
    this.attributes = new Map()
    this.children = []
    this.listeners = new Map()
    this.ownText = ''
  }

  setAttribute (name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute (name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  append (...nodes) {
    this.children.push(...nodes)
  }

  addEventListener (type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  // what a browser would hand the chart's listeners
  dispatch (type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault () {}, ...event })
    }
  }

  // drawn at exactly its viewBox size, so clientX is a viewBox x
  getBoundingClientRect () {
    const [, , width, height] = this.getAttribute('viewBox').split(' ').map(Number)
    return { left: 0, top: 0, width, height }
  }

  set textContent (text) {
    this.children = []
    this.ownText = String(text)
  }

  get textContent () {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }
}

globalThis.document = {
  createElementNS (namespace, tagName) {
    assert.equal(namespace, SVG_NS)
    return new FakeElement(tagName)
  }
}

const {
  progressChart,
  speedChart,
  outcomeDonut,
  formatClockMs,
  formatSpeed
} = require('../charts')

const MB = 1024 * 1024

// --- looking at what was drawn ---

function descendants (node) {
  return node.children.flatMap((child) => [child, ...descendants(child)])
}

function withClass (node, className) {
  return descendants(node).filter((child) =>
    (child.getAttribute('class') ?? '').split(/\s+/).includes(className)
  )
}

function texts (node) {
  return descendants(node)
    .filter((child) => child.tagName === 'text')
    .map((child) => child.textContent)
}

// "M10 20 L30 40" -> [[10, 20], [30, 40]]
function pathPoints (d) {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/g)].map((match) => [
    Number(match[1]),
    Number(match[2])
  ])
}

function linePoints (svg, className) {
  const [line] = withClass(svg, className)
  return pathPoints(line.getAttribute('d'))
}

// [elapsed ms, songs done, MB/s] -> the points GET /progress sends in `history`
function historyOf (rows) {
  return rows.map(([t, done, speedMBps = 1]) => ({
    t,
    done,
    savedBytes: done * 4 * MB,
    speedBps: speedMBps * MB,
    active: 3,
    parallel: 3
  }))
}

// 8 s in, 3 songs done; speeds 0, 1, 2, 1.5, 1 MB/s (average 1.1)
const HISTORY = historyOf([
  [0, 0, 0],
  [2000, 0, 1],
  [4000, 1, 2],
  [6000, 2, 1.5],
  [8000, 3, 1]
])

// --- time and speed as the charts (and the countdown) write them ---

test('time reads as m:ss, or h:mm:ss from an hour up', () => {
  assert.equal(formatClockMs(0), '0:00')
  assert.equal(formatClockMs(245_000), '4:05')
  assert.equal(formatClockMs(3_599_000), '59:59')
  assert.equal(formatClockMs(3_600_000), '1:00:00')
  assert.equal(formatClockMs(3_723_000), '1:02:03')
})

test('time never reads below zero', () => {
  assert.equal(formatClockMs(-5000), '0:00')
})

test('speeds read in MB/s, matching the speed axis', () => {
  assert.equal(formatSpeed(1.4 * MB), '1.4 MB/s')
  assert.equal(formatSpeed(12.3 * MB), '12 MB/s')
  assert.equal(formatSpeed(0.05 * MB), '0.05 MB/s')
  assert.equal(formatSpeed(0), '0 MB/s')
})

// --- songs done over time ---

test('the progress chart is a scalable picture with a summary for screen readers', () => {
  const svg = progressChart(HISTORY, { total: 10, etaMs: 20_000 })

  assert.equal(svg.tagName, 'svg')
  assert.equal(svg.getAttribute('role'), 'img')
  assert.equal(svg.getAttribute('width'), '100%')
  assert.match(svg.getAttribute('viewBox'), /^0 0 \d+ \d+$/)
  assert.match(svg.getAttribute('aria-label'), /3 of 10 songs done/)
  assert.match(svg.getAttribute('aria-label'), /0:20 left/)
})

test('songs done are one line through every point, rising as songs finish', () => {
  const points = linePoints(progressChart(HISTORY, { total: 10 }), 'chart-line')

  assert.equal(points.length, HISTORY.length)
  assert.ok(points.at(-1)[1] < points[0][1], 'more songs done sits higher')
  assert.ok(points.at(-1)[0] > points[0][0], 'later sits further right')
})

test('a dashed projection runs from the latest point up to the total', () => {
  const svg = progressChart(HISTORY, { total: 10, etaMs: 20_000 })
  const line = linePoints(svg, 'chart-line')
  const [start, end] = linePoints(svg, 'chart-projection')

  assert.deepEqual(start, line.at(-1))
  assert.ok(end[0] > start[0], 'it ends later')
  assert.ok(end[1] < start[1], 'it ends higher: every song done')
})

test('the projection reaches the top of the songs axis, where the total is', () => {
  const svg = progressChart(HISTORY, { total: 10, etaMs: 20_000 })
  const [, end] = linePoints(svg, 'chart-projection')
  const topGridline = Math.min(
    ...withClass(svg, 'chart-grid').map((line) => Number(line.getAttribute('y1')))
  )

  assert.equal(end[1], topGridline)
})

test('there is no projection while the time left is unknown', () => {
  const svg = progressChart(HISTORY, { total: 10, etaMs: null })

  assert.equal(withClass(svg, 'chart-projection').length, 0)
  assert.match(svg.getAttribute('aria-label'), /time left not known yet/)
})

test('there is no projection once every song is done', () => {
  const finished = historyOf([[0, 0], [2000, 1], [4000, 2]])

  assert.equal(withClass(progressChart(finished, { total: 2, etaMs: 0 }), 'chart-projection').length, 0)
})

test('the songs axis runs from 0 up to the total', () => {
  const labels = withClass(progressChart(HISTORY, { total: 37 }), 'chart-tick-y').map(
    (label) => label.textContent
  )

  assert.equal(labels[0], '0')
  assert.equal(labels.at(-1), '37')
})

test('the time axis is labeled in m:ss', () => {
  const labels = withClass(progressChart(HISTORY, { total: 10 }), 'chart-tick-x').map(
    (label) => label.textContent
  )

  assert.ok(labels.length >= 2)
  for (const label of labels) assert.match(label, /^\d+:\d{2}(:\d{2})?$/)
})

// a run like the live one: 61 songs skipped at the start, then one every 3.55 s, up to 6:00
const LIVE_RUN = historyOf(
  Array.from({ length: 181 }, (_, i) => [i * 2000, 61 + Math.floor((i * 2000) / 3550)])
)

function timeTickXs (svg) {
  return withClass(svg, 'chart-tick-x').map((label) => label.getAttribute('x'))
}

test('the time axis stays put when the time left changes a little: only the projection end moves', () => {
  const at2413 = progressChart(LIVE_RUN, { total: 500, etaMs: (24 * 60 + 13) * 1000 })
  const at2655 = progressChart(LIVE_RUN, { total: 500, etaMs: (26 * 60 + 55) * 1000 })

  assert.deepEqual(timeTickXs(at2655), timeTickXs(at2413))
  assert.equal(withClass(at2655, 'chart-line')[0].getAttribute('d'), withClass(at2413, 'chart-line')[0].getAttribute('d'))
  assert.notEqual(
    withClass(at2655, 'chart-target')[0].getAttribute('cx'),
    withClass(at2413, 'chart-target')[0].getAttribute('cx')
  )
})

// the time axis' end for a run 8 s in that ends at `endMs`
function spanFor (endMs, previousSpanMs = null) {
  const svg = progressChart(HISTORY, { total: 10, etaMs: endMs - 8000, previousSpanMs })
  return Number(svg.getAttribute('data-span-ms'))
}

test('the time axis ends half a tick step past the end of the run, and grows in such steps', () => {
  assert.equal(spanFor(34 * 60_000), 35 * 60_000)
  assert.equal(spanFor(35 * 60_000), 35 * 60_000)
  assert.equal(spanFor(36 * 60_000), 40 * 60_000)
})

test('the axis keeps the end it had while the run still fits, and shrinks once it falls well short', () => {
  assert.equal(spanFor(34.5 * 60_000, 40 * 60_000), 40 * 60_000)
  assert.equal(spanFor(29 * 60_000, 40 * 60_000), 30 * 60_000)
  // a run that outgrows it gets a longer axis at once
  assert.equal(spanFor(41 * 60_000, 40 * 60_000), 45 * 60_000)
})

test('an empty or one-point history shows a waiting note instead of a chart', () => {
  for (const history of [[], historyOf([[0, 0]]), undefined]) {
    const svg = progressChart(history, { total: 10 })

    assert.match(svg.textContent, /Waiting for data/)
    assert.match(svg.getAttribute('aria-label'), /waiting for data/)
    assert.equal(withClass(svg, 'chart-line').length, 0)
  }
})

test('broken points are left out rather than drawn', () => {
  const svg = progressChart([...HISTORY, { t: 'soon', done: null }, null], { total: 10 })

  assert.equal(linePoints(svg, 'chart-line').length, HISTORY.length)
})

// --- reading a value off a line chart ---

test('the readout above the chart shows the latest values to begin with', () => {
  const svg = progressChart(HISTORY, { total: 10 })

  assert.match(withClass(svg, 'chart-readout')[0].textContent, /3 of 10 songs at 0:08/)
})

test('hovering shows a guide at the nearest point and reads out its values', () => {
  const svg = progressChart(HISTORY, { total: 10 })
  const [guide] = withClass(svg, 'chart-crosshair')
  const [readout] = withClass(svg, 'chart-readout')
  const secondX = linePoints(svg, 'chart-line')[1][0]

  assert.equal(guide.getAttribute('visibility'), 'hidden')
  svg.dispatch('pointermove', { clientX: secondX + 1 })
  assert.equal(guide.getAttribute('visibility'), 'visible')
  assert.equal(Number(guide.getAttribute('x1')), secondX)
  assert.match(readout.textContent, /0 of 10 songs at 0:02/)

  svg.dispatch('pointerleave')
  assert.equal(guide.getAttribute('visibility'), 'hidden')
  assert.match(readout.textContent, /3 of 10 songs at 0:08/)
})

test('with the keyboard, the arrow keys step from point to point', () => {
  const svg = progressChart(HISTORY, { total: 10 })
  const [readout] = withClass(svg, 'chart-readout')

  assert.equal(svg.getAttribute('tabindex'), '0')
  svg.dispatch('focus')
  assert.match(readout.textContent, /3 of 10 songs at 0:08/)
  svg.dispatch('keydown', { key: 'ArrowLeft' })
  assert.match(readout.textContent, /2 of 10 songs at 0:06/)
  svg.dispatch('keydown', { key: 'Home' })
  assert.match(readout.textContent, /0 of 10 songs at 0:00/)
})

// --- download speed ---

test('download speed is an area under a line', () => {
  const svg = speedChart(HISTORY)

  assert.equal(withClass(svg, 'chart-area').length, 1)
  assert.equal(linePoints(svg, 'chart-speed-line').length, HISTORY.length)
})

test('the speed chart is the saving speed over the last 30 s', () => {
  assert.match(speedChart(HISTORY).getAttribute('aria-label'), /^Saving speed \(last 30 s\): /)
})

test('the current speed and the average are marked and summed up', () => {
  const svg = speedChart(HISTORY)
  const label = svg.getAttribute('aria-label')
  const readout = withClass(svg, 'chart-readout')[0].textContent

  assert.equal(withClass(svg, 'chart-average').length, 1)
  assert.equal(withClass(svg, 'chart-dot').length, 1)
  assert.match(label, /latest 1\.0 MB\/s/)
  assert.match(label, /1\.1 MB\/s on average/)
  assert.match(readout, /1\.0 MB\/s last 30 s/)
  assert.doesNotMatch(readout, /now/)
})

// the speed axis' labels, bottom to top, as numbers
function speedTicks (svg) {
  return withClass(svg, 'chart-tick-y').map((label) => Number(label.textContent))
}

test('a brief spike does not stretch the speed axis: it is drawn at the top edge', () => {
  // a steady 1 MB/s with one 30 MB/s reading 4 s in
  const svg = speedChart(
    historyOf([[0, 0, 1], [2000, 0, 1], [4000, 1, 30], [6000, 1, 1], [8000, 2, 1], [10_000, 2, 1], [12_000, 3, 1]])
  )
  const points = linePoints(svg, 'chart-speed-line')
  const topGridline = Math.min(...withClass(svg, 'chart-grid').map((line) => Number(line.getAttribute('y1'))))

  assert.ok(speedTicks(svg).at(-1) <= 2, `the axis tops out at ${speedTicks(svg).at(-1)} MB/s`)
  assert.equal(points[2][1], topGridline)
  assert.equal(Math.min(...points.map(([, y]) => y)), topGridline)

  // its real value is still there to read
  svg.dispatch('pointermove', { clientX: points[2][0] })
  assert.match(withClass(svg, 'chart-readout')[0].textContent, /30 MB\/s at 0:04/)
})

test('the latest speed always fits on the speed axis', () => {
  const svg = speedChart(historyOf([[0, 0, 1], [2000, 0, 1], [4000, 1, 1], [6000, 1, 1], [8000, 2, 9]]))

  assert.ok(speedTicks(svg).at(-1) >= 9)
})

test('slow speeds sit on an axis of at least 1 MB/s', () => {
  const svg = speedChart(historyOf([[0, 0, 0.2], [2000, 0, 0.3], [4000, 1, 0.25]]))

  assert.equal(speedTicks(svg).at(-1), 1)
})

test('the speed axis tops out at a round number at or just above the fastest reading', () => {
  const svg = speedChart(historyOf([[0, 0, 4], [2000, 0, 6], [4000, 1, 7.2]]))

  assert.equal(speedTicks(svg).at(-1), 8)
})

test('the average line sits at the average speed', () => {
  // a steady 2 MB/s: the average is the line itself
  const svg = speedChart(historyOf([[0, 0, 2], [2000, 0, 2], [4000, 1, 2]]))
  const [average] = withClass(svg, 'chart-average')

  assert.equal(Number(average.getAttribute('y1')), linePoints(svg, 'chart-speed-line')[0][1])
})

test('with nothing downloading the speed stays on the baseline', () => {
  const svg = speedChart(historyOf([[0, 0, 0], [2000, 0, 0], [4000, 0, 0]]))
  const heights = new Set(linePoints(svg, 'chart-speed-line').map(([, y]) => y))

  assert.equal(heights.size, 1)
  assert.match(svg.getAttribute('aria-label'), /latest 0 MB\/s/)
})

test('a short speed history shows the waiting note', () => {
  const svg = speedChart(historyOf([[0, 0, 1]]))

  assert.match(svg.textContent, /Waiting for data/)
  assert.equal(withClass(svg, 'chart-area').length, 0)
})

// --- what became of the songs ---

test('the outcome ring has one arc per part that is not zero', () => {
  const svg = outcomeDonut({ saved: 9, skipped: 1, review: 0, failed: 2, left: 25 })

  assert.equal(withClass(svg, 'donut-saved').length, 1)
  assert.equal(withClass(svg, 'donut-skipped').length, 1)
  assert.equal(withClass(svg, 'donut-review').length, 0)
  assert.equal(withClass(svg, 'donut-failed').length, 1)
  assert.equal(withClass(svg, 'donut-left').length, 1)
})

test('the middle of the ring reads done/total', () => {
  const svg = outcomeDonut({ saved: 9, skipped: 1, review: 1, failed: 1, left: 25 })

  assert.ok(texts(svg).includes('12/37'))
})

test('the ring is summed up for screen readers', () => {
  const label = outcomeDonut({ saved: 9, skipped: 0, review: 1, failed: 1, left: 25 })
    .getAttribute('aria-label')

  assert.match(label, /11 of 36 songs done/)
  assert.match(label, /9 saved/)
  assert.match(label, /1 to review/)
  assert.match(label, /25 left/)
  assert.doesNotMatch(label, /skipped/)
})

test('bigger parts get longer arcs', () => {
  // three quarters saved: its arc goes the long way round
  const svg = outcomeDonut({ saved: 3, skipped: 0, review: 0, failed: 0, left: 1 })

  assert.match(withClass(svg, 'donut-saved')[0].getAttribute('d'), /A[\d. ]+ 0 1 1 /)
  assert.match(withClass(svg, 'donut-left')[0].getAttribute('d'), /A[\d. ]+ 0 0 1 /)
})

test('a part on its own fills the whole ring', () => {
  const [ring] = withClass(outcomeDonut({ saved: 0, skipped: 0, review: 0, failed: 0, left: 12 }), 'donut-left')

  assert.equal(ring.tagName, 'circle')
})

test('each arc names its part, count and share on hover', () => {
  const svg = outcomeDonut({ saved: 3, skipped: 0, review: 0, failed: 0, left: 1 })

  assert.match(withClass(svg, 'donut-saved')[0].textContent, /Saved: 3 \(75%\)/)
})

test('missing or broken counts count as zero', () => {
  const svg = outcomeDonut({ saved: 2, review: -1, failed: 'x', left: 2 })

  assert.ok(texts(svg).includes('2/4'))
})

test('a ring with no songs at all shows the waiting note', () => {
  const svg = outcomeDonut({ saved: 0, skipped: 0, review: 0, failed: 0, left: 0 })

  assert.match(svg.textContent, /Waiting for data/)
})

// --- what every chart shares ---

test('colors come only from CSS classes, so dark mode can switch them', () => {
  const charts = [
    progressChart(HISTORY, { total: 10, etaMs: 5000 }),
    speedChart(HISTORY),
    outcomeDonut({ saved: 1, skipped: 1, review: 1, failed: 1, left: 1 })
  ]

  for (const svg of charts) {
    for (const node of [svg, ...descendants(svg)]) {
      for (const name of ['fill', 'stroke', 'style', 'color', 'opacity']) {
        assert.equal(node.getAttribute(name), null, `<${node.tagName}> sets ${name}`)
      }
    }
  }
})

test('charts never animate, so reduced motion needs nothing switched off', () => {
  const svg = progressChart(HISTORY, { total: 10, etaMs: 5000 })
  const animations = descendants(svg).filter((node) => /^(animate|set)/.test(node.tagName))

  assert.equal(animations.length, 0)
})

test('charts.js never builds markup from strings', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'charts.js'), 'utf8')

  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/)
})
