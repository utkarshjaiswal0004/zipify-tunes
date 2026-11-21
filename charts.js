// ZipifyTunes charts: small SVG pictures of a run for the "Live stats" card.
// Each builder takes the plain numbers GET /progress sends and returns a new
// <svg>, which the page swaps in on every poll. Colors come only from CSS
// classes (app.css), so dark mode switches them along with the rest of the page.
//
// A classic script loaded before app.js. It adds window.ZipifyCharts (and,
// under Node, module.exports for the tests); everything else stays inside
// this function, out of the page's shared global scope.

(function (root) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  // The line charts' drawing space. Two charts side by side in the card are
  // about 210-270 px wide, so a unit stays close to a CSS pixel and the
  // labels stay readable; the picture scales to fit its box.
  const WIDTH = 260;
  const HEIGHT = 156;
  const PLOT = { left: 28, right: 250, top: 24, bottom: 134 };
  const READOUT_Y = 12; // the readout line above the plot
  const TICK_GAP = 4; // tick labels sit this far from the plot
  const TIME_LABEL_Y = PLOT.bottom + 14;
  const RIGHT_LABEL_ROOM = 16; // a time label closer than this to the edge is right-aligned

  const MIN_POINTS = 2; // fewer can't make a line: the chart says "waiting" instead
  const MIN_SPAN_MS = 10_000; // the time axis never squeezes into less than this
  const TICK_TARGET = 4; // about this many steps per axis
  const TOP_TICK_ROOM = 0.2; // a gridline this close (share of the axis) below the top one is dropped
  const MB = 1024 * 1024; // MB the way the rest of the page counts them

  // The speed axis fits the usual speeds, not a brief spike: a reading over
  // SPEED_SPIKE_FACTOR times the typical one (3 in 4 readings are at or below
  // it) is drawn at the top edge instead of stretching the axis. It reaches
  // at least MIN_SPEED_TOP_MB, so a slow line isn't blown up to fill the plot.
  const SPEED_TYPICAL_SHARE = 0.75;
  const SPEED_SPIKE_FACTOR = 2;
  const MIN_SPEED_TOP_MB = 1;

  // steps people count time in: 5 s … 1 day
  const TIME_STEPS_MS = [
    5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400,
  ].map((seconds) => seconds * 1000);

  // The outcome ring: thin, with a 2-unit gap of card between neighbouring
  // arcs, and every non-zero part at least a sliver.
  const DONUT = { size: 120, radius: 48, thickness: 12, gap: 2, minArc: 0.03 };
  const DONUT_CENTER = DONUT.size / 2;
  const DIGIT_WIDTH_EM = 0.6; // about how wide a digit is, to fit "done/total" inside the ring
  const DONUT_VALUE_MAX_SIZE = 22;

  // Arcs go clockwise from the top in this order. With the page's colors,
  // amber (to review) right beside red (failed) is hard to tell apart for
  // red-green colorblind readers, so those two never touch (checked with a
  // colorblindness simulation). The legend and each arc's tooltip name the
  // parts, so color is never the only clue. (The page builds its legend
  // from this list too, so the two can't drift apart.) Reused songs (blue,
  // copied from another playlist's folder) sit between saved and to review;
  // a run that reuses none draws no arc for them.
  const OUTCOMES = Object.freeze(
    [
      { key: "saved", label: "Saved", phrase: "saved" },
      { key: "reused", label: "Reused", phrase: "reused" },
      { key: "review", label: "To review", phrase: "to review" },
      { key: "skipped", label: "Skipped", phrase: "skipped" },
      { key: "failed", label: "Failed", phrase: "failed" },
      { key: "left", label: "Left", phrase: "left" },
    ].map(Object.freeze)
  );

  const PROGRESS_TITLE = "Songs done over time";
  // the server sends each point's speed as what was saved over the 30 s before it
  const SPEED_TITLE = "Saving speed (last 30 s)";
  const OUTCOME_TITLE = "Outcomes";

  // --- small helpers ---

  // <tag attribute="…">text</tag> in the SVG namespace; null attributes are skipped
  function svgNode(tag, attributes = {}, text = null) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value != null) node.setAttribute(name, String(value));
    }
    if (text != null) node.textContent = text;
    return node;
  }

  // one decimal place is plenty on a drawing this size, and keeps paths short
  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  // 245000 -> "4:05", 3723000 -> "1:02:03" (to the nearest second, never below 0)
  function formatClockMs(ms) {
    const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  }

  // bytes per second in MB/s, the speed axis' unit: "0.05 MB/s", "1.4 MB/s", "12 MB/s"
  function formatSpeed(bytesPerSecond) {
    const mbps = Math.max(0, Number(bytesPerSecond) || 0) / MB;
    if (mbps === 0) return "0 MB/s";
    if (mbps < 0.1) return `${mbps.toFixed(2)} MB/s`;
    if (mbps < 10) return `${mbps.toFixed(1)} MB/s`;
    return `${Math.round(mbps)} MB/s`;
  }

  // 0.5 -> "0.5", 2 -> "2": axis numbers without float noise
  function formatTickNumber(value) {
    return String(Number(value.toPrecision(3)));
  }

  // the points a chart can place: elapsed time and songs done both known
  function usablePoints(history) {
    if (!Array.isArray(history)) return [];
    return history.filter((point) => Number.isFinite(point?.t) && Number.isFinite(point?.done));
  }

  function speedOf(point) {
    return Number.isFinite(point.speedBps) && point.speedBps > 0 ? point.speedBps : 0;
  }

  // value in [0, max] -> position from `from` to `to`
  function scale(max, from, to) {
    const span = max > 0 ? max : 1;
    return (value) => round1(from + (value / span) * (to - from));
  }

  // --- axes ---

  // the 1, 2 or 5 (times a power of ten) at or above `rough`
  function niceStep(rough) {
    const power = 10 ** Math.floor(Math.log10(rough));
    const scaled = rough / power;
    const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return nice * power;
  }

  // 0, step, 2·step … up to max: about TICK_TARGET steps
  function valueTicks(max, minStep = 0) {
    if (!(max > 0)) return [0];
    const step = Math.max(niceStep(max / TICK_TARGET), minStep);
    const count = Math.floor(max / step + 1e-9);
    return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  }

  // Whole songs from 0 up to the total. The total always gets its own line
  // (it's where the run ends); a nice line just under it would crowd it.
  function songTicks(total) {
    const below = valueTicks(total, 1).filter(
      (value) => value === 0 || total - value >= total * TOP_TICK_ROOM
    );
    return [...below, total];
  }

  // `value` rounded up to a whole number of nice steps: 7.2 -> 8, 1.1 -> 1.5
  function niceCeiling(value) {
    const step = niceStep(value / TICK_TARGET);
    return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(12));
  }

  // The speed axis' top in MB/s: the fastest reading rounded up to a nice
  // step, unless it's a spike well over the typical reading (see
  // SPEED_SPIKE_FACTOR). The latest reading always fits, so the "now" dot is
  // never pinned to the edge. speedsMBps: the readings, oldest first.
  function speedAxisTop(speedsMBps) {
    const moving = speedsMBps.filter((speed) => speed > 0).sort((a, b) => a - b);
    if (!moving.length) return MIN_SPEED_TOP_MB;
    const typical = moving[Math.floor(SPEED_TYPICAL_SHARE * (moving.length - 1))];
    const ceiling = Math.max(typical * SPEED_SPIKE_FACTOR, speedsMBps.at(-1));
    return niceCeiling(Math.max(MIN_SPEED_TOP_MB, Math.min(moving.at(-1), ceiling)));
  }

  // the step people count in (30 s, 5 min…) that gives a time axis `maxMs`
  // long about TICK_TARGET steps
  function timeStep(maxMs) {
    return TIME_STEPS_MS.find((ms) => maxMs / ms <= TICK_TARGET) ?? TIME_STEPS_MS.at(-1);
  }

  // 0, step, 2·step … up to maxMs
  function timeTicks(maxMs) {
    const step = timeStep(maxMs);
    return Array.from({ length: Math.floor(maxMs / step + 1e-9) + 1 }, (_, i) => i * step);
  }

  // The time axis' end for a run that ends at `endMs`: rounded up to half a
  // tick step, so a new time left within that half step leaves the axis (and
  // the line drawn so far) where it was, and only the projection's end
  // moves. `previousMs`, the end the axis had last time, stays while the run
  // still fits in it and its rounded end is at most a half step short of it,
  // so an end hovering at a boundary doesn't flip the axis to and fro.
  function timeAxisEnd(endMs, previousMs = null) {
    const half = timeStep(endMs) / 2;
    const fitted = Math.max(Math.ceil(endMs / half - 1e-9) * half, MIN_SPAN_MS);
    const isPreviousKept = Number.isFinite(previousMs) && previousMs >= endMs && previousMs <= fitted + half;
    return isPreviousKept ? previousMs : fitted;
  }

  // hairline gridlines with their values on the left; the 0 line is the axis
  function valueAxis(ticks, y, format) {
    return ticks.flatMap((value) => [
      svgNode("line", {
        class: value === 0 ? "chart-axis" : "chart-grid",
        x1: PLOT.left,
        x2: PLOT.right,
        y1: y(value),
        y2: y(value),
      }),
      svgNode(
        "text",
        {
          class: "chart-tick chart-tick-y",
          x: PLOT.left - TICK_GAP,
          y: y(value),
          "text-anchor": "end",
          "dominant-baseline": "middle",
        },
        format(value)
      ),
    ]);
  }

  // elapsed-time labels under the plot; one at the right edge is right-aligned
  // so it stays inside the picture
  function timeAxis(ticks, x) {
    return ticks.map((ms) => {
      const position = x(ms);
      const anchor = position > WIDTH - RIGHT_LABEL_ROOM ? "end" : "middle";
      return svgNode(
        "text",
        { class: "chart-tick chart-tick-x", x: position, y: TIME_LABEL_Y, "text-anchor": anchor },
        formatClockMs(ms)
      );
    });
  }

  // --- shared pieces ---

  function chartSvg(kind, label, width = WIDTH, height = HEIGHT) {
    return svgNode("svg", {
      class: `chart chart-${kind}`,
      viewBox: `0 0 ${width} ${height}`,
      width: "100%",
      role: "img",
      "aria-label": label,
    });
  }

  // Shown in a chart's place until there's enough to draw, rather than a
  // broken or misleading picture.
  function waitingChart(kind, title, width = WIDTH, height = HEIGHT) {
    const svg = chartSvg(kind, `${title}: waiting for data`, width, height);
    svg.append(
      svgNode("rect", {
        class: "chart-placeholder",
        x: 1,
        y: 1,
        width: width - 2,
        height: height - 2,
        rx: 8,
      }),
      svgNode(
        "text",
        {
          class: "chart-note",
          x: width / 2,
          y: height / 2,
          "text-anchor": "middle",
          "dominant-baseline": "middle",
        },
        "Waiting for data…"
      )
    );
    return svg;
  }

  // "M x y L x y …" through the marks
  function linePath(marks) {
    return marks.map(({ x, y }, i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  }

  // the line's shape closed down to the baseline: the area under it
  function areaPath(marks) {
    const first = marks[0];
    const last = marks.at(-1);
    return `${linePath(marks)} L${last.x} ${PLOT.bottom} L${first.x} ${PLOT.bottom} Z`;
  }

  // --- reading values off a line chart (pointer or keyboard) ---

  // where the pointer is, in drawing units (the picture keeps its proportions)
  function viewX(svg, clientX) {
    const box = svg.getBoundingClientRect();
    return box.width ? ((clientX - box.left) / box.width) * WIDTH : null;
  }

  function nearestIndex(marks, x) {
    if (x == null) return null;
    return marks.reduce(
      (best, mark, i) => (Math.abs(mark.x - x) < Math.abs(marks[best].x - x) ? i : best),
      0
    );
  }

  // ArrowLeft/ArrowRight step one point, Home/End jump to the ends; other keys: null
  function steppedIndex(key, current, last) {
    if (key === "ArrowLeft") return Math.max(0, current - 1);
    if (key === "ArrowRight") return Math.min(last, current + 1);
    if (key === "Home") return 0;
    if (key === "End") return last;
    return null;
  }

  // A guide line at the point nearest the pointer (or picked with the arrow
  // keys), its values in the readout above the plot. Otherwise the readout
  // shows the latest values, so nothing is only readable by hovering.
  // describe(i) words point i.
  function addCrosshair(svg, marks, describe) {
    const latest = marks.length - 1;
    const guide = svgNode("line", {
      class: "chart-crosshair",
      x1: 0,
      x2: 0,
      y1: PLOT.top,
      y2: PLOT.bottom,
      visibility: "hidden",
    });
    const focusDot = svgNode("circle", { class: "chart-focus", cx: 0, cy: 0, r: 4, visibility: "hidden" });
    const readout = svgNode("text", { class: "chart-readout", x: PLOT.left, y: READOUT_Y }, describe(latest));
    let shownIndex = null; // the point the guide is on; null while it's hidden

    function show(index) {
      shownIndex = index;
      const visibility = index == null ? "hidden" : "visible";
      guide.setAttribute("visibility", visibility);
      focusDot.setAttribute("visibility", visibility);
      readout.textContent = describe(index ?? latest);
      if (index == null) return;
      const { x, y } = marks[index];
      guide.setAttribute("x1", x);
      guide.setAttribute("x2", x);
      focusDot.setAttribute("cx", x);
      focusDot.setAttribute("cy", y);
    }

    const showNearest = (event) => show(nearestIndex(marks, viewX(svg, event.clientX)));
    svg.setAttribute("tabindex", "0");
    svg.addEventListener("pointermove", showNearest);
    svg.addEventListener("pointerdown", showNearest);
    svg.addEventListener("pointerleave", () => show(null));
    svg.addEventListener("focus", () => show(shownIndex ?? latest));
    svg.addEventListener("blur", () => show(null));
    svg.addEventListener("keydown", (event) => {
      const next = steppedIndex(event.key, shownIndex ?? latest, latest);
      if (next == null) return;
      event.preventDefault(); // the arrows move the guide, not the page
      show(next);
    });
    svg.append(guide, focusDot, readout);
  }

  // --- songs done over time ---

  // "Songs done over time: 3 of 10 songs done after 0:08, about 0:20 left."
  function progressLabel(latest, songs, etaMs) {
    let left = "time left not known yet";
    if (latest.done >= songs) left = "all done";
    else if (etaMs != null) left = `about ${formatClockMs(etaMs)} left`;
    return `${PROGRESS_TITLE}: ${latest.done} of ${songs} songs done after ${formatClockMs(latest.t)}, ${left}.`;
  }

  // Songs done over the run's elapsed time as a line. While the time left is
  // known, a dashed line carries on from the latest point to the total, where
  // the run would end at that pace. The time axis only moves in half steps
  // (see timeAxisEnd): `previousSpanMs` is where it ended last time, and the
  // picture says where it ends now in its data-span-ms attribute.
  function progressChart(history, { total = 0, etaMs = null, previousSpanMs = null } = {}) {
    const points = usablePoints(history);
    if (points.length < MIN_POINTS) return waitingChart("progress", PROGRESS_TITLE);

    const latest = points.at(-1);
    const songs = Math.max(Number(total) || 0, ...points.map((point) => point.done), 1);
    const hasProjection = Number.isFinite(etaMs) && etaMs > 0 && latest.done < songs;
    const endMs = hasProjection ? latest.t + etaMs : latest.t;
    const spanMs = timeAxisEnd(endMs, previousSpanMs);
    const x = scale(spanMs, PLOT.left, PLOT.right);
    const y = scale(songs, PLOT.bottom, PLOT.top);
    const marks = points.map((point) => ({ x: x(point.t), y: y(point.done) }));
    const end = marks.at(-1);

    const svg = chartSvg("progress", progressLabel(latest, songs, hasProjection ? etaMs : null));
    svg.setAttribute("data-span-ms", String(spanMs));
    svg.append(...valueAxis(songTicks(songs), y, String), ...timeAxis(timeTicks(spanMs), x));
    if (hasProjection) {
      const finish = { x: x(endMs), y: y(songs) };
      svg.append(
        svgNode("path", { class: "chart-projection", d: linePath([end, finish]) }),
        svgNode("circle", { class: "chart-target", cx: finish.x, cy: finish.y, r: 3 })
      );
    }
    svg.append(
      svgNode("path", { class: "chart-line", d: linePath(marks) }),
      svgNode("circle", { class: "chart-dot", cx: end.x, cy: end.y, r: 4 })
    );
    addCrosshair(svg, marks, (i) => `${points[i].done} of ${songs} songs at ${formatClockMs(points[i].t)}`);
    return svg;
  }

  // --- saving speed ---

  // How fast songs come in (what was saved over the 30 s before each point)
  // as an area over time. The latest speed gets a dot and the average a
  // dashed line (named in the card's caption, since a label on the plot
  // would sit on top of a jagged speed line), and the readout above the plot
  // gives both. A spike over the axis is drawn at its top edge; the readout
  // still gives its real value.
  function speedChart(history) {
    const points = usablePoints(history);
    if (points.length < MIN_POINTS) return waitingChart("speed", SPEED_TITLE);

    const speeds = points.map(speedOf);
    const current = speeds.at(-1);
    const average = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
    const top = speedAxisTop(speeds.map((speed) => speed / MB));
    const spanMs = Math.max(points.at(-1).t, MIN_SPAN_MS);
    const x = scale(spanMs, PLOT.left, PLOT.right);
    const y = scale(top, PLOT.bottom, PLOT.top);
    const yOfSpeed = (bytesPerSecond) => y(Math.min(bytesPerSecond / MB, top));
    const marks = points.map((point, i) => ({ x: x(point.t), y: yOfSpeed(speeds[i]) }));
    const end = marks.at(-1);
    const averageY = yOfSpeed(average);
    const summary = `${formatSpeed(current)} last 30 s · ${formatSpeed(average)} average`;

    const svg = chartSvg(
      "speed",
      `${SPEED_TITLE}: latest ${formatSpeed(current)}, ${formatSpeed(average)} on average.`
    );
    svg.append(
      ...valueAxis(valueTicks(top), y, formatTickNumber),
      ...timeAxis(timeTicks(spanMs), x),
      svgNode("path", { class: "chart-area", d: areaPath(marks) }),
      svgNode("path", { class: "chart-speed-line", d: linePath(marks) }),
      svgNode("line", { class: "chart-average", x1: PLOT.left, x2: PLOT.right, y1: averageY, y2: averageY }),
      svgNode("circle", { class: "chart-dot chart-dot-speed", cx: end.x, cy: end.y, r: 4 })
    );
    addCrosshair(svg, marks, (i) =>
      i === marks.length - 1 ? summary : `${formatSpeed(speeds[i])} at ${formatClockMs(points[i].t)}`
    );
    return svg;
  }

  // --- what became of the songs ---

  function wholeCount(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  // a point on the ring; angle 0 is the top, growing clockwise
  function ringPoint(angle) {
    return [
      round1(DONUT_CENTER + DONUT.radius * Math.sin(angle)),
      round1(DONUT_CENTER - DONUT.radius * Math.cos(angle)),
    ];
  }

  // An arc of the ring, clockwise from `start` for `sweep` radians, pulled in
  // by half the gap at each end so neighbouring arcs keep a sliver of card.
  function arcPath(start, sweep) {
    const gap = DONUT.gap / DONUT.radius;
    const from = start + gap / 2;
    const to = from + Math.max(sweep - gap, DONUT.minArc);
    const largeArc = to - from > Math.PI ? 1 : 0;
    const [x1, y1] = ringPoint(from);
    const [x2, y2] = ringPoint(to);
    return `M${x1} ${y1} A${DONUT.radius} ${DONUT.radius} 0 ${largeArc} 1 ${x2} ${y2}`;
  }

  // one part's arc (a whole circle when it's the only part), titled for hover
  function arcNode({ part, start, sweep }, isOnlyPart, total) {
    // the thickness lives here, beside the geometry that leaves room for it
    const ring = { class: `donut-arc donut-${part.key}`, "stroke-width": DONUT.thickness };
    const node = isOnlyPart
      ? svgNode("circle", { ...ring, cx: DONUT_CENTER, cy: DONUT_CENTER, r: DONUT.radius })
      : svgNode("path", { ...ring, d: arcPath(start, sweep) });
    const share = Math.round((part.count / total) * 100);
    node.append(svgNode("title", {}, `${part.label}: ${part.count} (${share}%)`));
    return node;
  }

  // "12/37" in the middle, as large as fits inside the ring, over "songs done"
  function centerText(done, total) {
    const text = `${done}/${total}`;
    const room = 2 * (DONUT.radius - DONUT.thickness / 2) - DONUT.thickness;
    const fontSize = Math.min(DONUT_VALUE_MAX_SIZE, Math.floor(room / (text.length * DIGIT_WIDTH_EM)));
    return [
      svgNode(
        "text",
        { class: "donut-value", x: DONUT_CENTER, y: DONUT_CENTER + 3, "text-anchor": "middle", "font-size": fontSize },
        text
      ),
      svgNode(
        "text",
        { class: "donut-caption", x: DONUT_CENTER, y: DONUT_CENTER + 17, "text-anchor": "middle" },
        "songs done"
      ),
    ];
  }

  // "Outcomes: 12 of 37 songs done: 9 saved, 1 to review, 1 failed, 25 left."
  function donutLabel(done, total, parts) {
    const counts = parts.map((part) => `${part.count} ${part.phrase}`).join(", ");
    return `${OUTCOME_TITLE}: ${done} of ${total} songs done: ${counts}.`;
  }

  // Songs saved / reused / to review / skipped / failed / still to go as one
  // ring, with done/total in the middle. Parts at zero (or missing) draw nothing.
  function outcomeDonut(counts = {}) {
    const parts = OUTCOMES.map((outcome) => ({ ...outcome, count: wholeCount(counts?.[outcome.key]) }));
    const total = parts.reduce((sum, part) => sum + part.count, 0);
    if (!total) return waitingChart("donut", OUTCOME_TITLE, DONUT.size, DONUT.size);

    const left = parts.find((part) => part.key === "left").count;
    const shown = parts.filter((part) => part.count > 0);
    const arcs = shown.map((part, i) => {
      const before = shown.slice(0, i).reduce((sum, earlier) => sum + earlier.count, 0);
      return { part, start: (before / total) * 2 * Math.PI, sweep: (part.count / total) * 2 * Math.PI };
    });

    const svg = chartSvg("donut", donutLabel(total - left, total, shown), DONUT.size, DONUT.size);
    svg.append(
      ...arcs.map((arc) => arcNode(arc, shown.length === 1, total)),
      ...centerText(total - left, total)
    );
    return svg;
  }

  const ZipifyCharts = Object.freeze({
    progressChart,
    speedChart,
    outcomeDonut,
    formatClockMs,
    formatSpeed,
    OUTCOMES,
  });

  if (typeof module === "object" && module.exports) {
    module.exports = ZipifyCharts;
  } else {
    root.ZipifyCharts = ZipifyCharts;
  }
})(typeof window === "undefined" ? globalThis : window);
