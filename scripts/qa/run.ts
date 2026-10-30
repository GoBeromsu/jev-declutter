import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const evidence = process.env.JEV_QA_EVIDENCE ?? resolve(root, ".omo/evidence/task-14-aside-feed-declutter");
const forcedHide = process.argv.includes("--force-hide");
const postPaintHideControl = process.argv.includes("--post-paint-hide-control");
const collisionControl = process.argv.includes("--fixture-collision-control");
const warningCheck = process.argv.includes("--warning-check");
const idleOscillationControl = process.argv.includes("--idle-oscillation-control");
const fixtures = [
  "youtube-en", "youtube-ko", "x-en", "x-ko", "instagram-en",
  "instagram-ko", "instagram-live-en", "instagram-live-ko", "linkedin-en", "linkedin-ko",
  "linkedin-react-en", "linkedin-react-ko", "stress-x-en", "x-messages-en"
] as const;

// Installed by CDP before navigation, including errors from either of the first scripts.
// Never return true from window.onerror or cancel the error event.
const beforeNavigation = String.raw`(() => {
  const m = window.__QA_METRICS__ = { errors: [], shifts: [], longtasks: [], first: {}, anchors: [], treatments: [], frame: 0 };
  requestAnimationFrame(function frame() { m.frame++; requestAnimationFrame(frame); });
  // Attribution windows for the long-task diagnostic in Q.report. Every callback the SCANNER
  // registers is wrapped, so the harness knows the exact [start,end] of scanner main-thread work.
  // The registering script is read from the registration stack: it names /__qa/content.js for the
  // scanner and the fixture document or /__qa/chrome-shim.js for the fixture and these drivers.
  // A re-registration from inside a scanner callback (the scanner's own rAF loop, its 120 ms
  // debounce) is attributed by the depth counter without touching a stack.
  // The scanner's own callbackDurations remain the BUDGET metric (p95 <= 4 ms, max <= 16 ms);
  // these windows only say WHEN it ran.
  // The one scanner entry point that is NOT a registration surface is a promise continuation
  // (after host.send, host.settings, host.cache, updateCache). It cannot be wrapped without
  // hooking Promise.prototype.then globally or changing src/, so it is closed on the WRITE side
  // instead: "every apply write happens inside a scanner callback" in Q.report is an assertion,
  // not a diagnostic, so a regression that moves treatment work into a continuation fails the run.
  const scanner = m.scanner = { windows: [], dropped: 0, byKind: {}, calls: {} };
  // Set by the drivers around their OWN deliberate data-jev writes (the forced-hide control), so
  // the write-side assertion can tell a harness control apart from scanner work.
  m.harnessWrite = false;
  let depth = 0;
  const scannerRegistered = () => {
    if (depth > 0) return true;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 4;
    const stack = new Error().stack;
    Error.stackTraceLimit = limit;
    return typeof stack === "string" && stack.includes("/__qa/content.js");
  };
  const scannerCallback = (kind, callback) => function (...args) {
    const start = performance.now();
    depth++;
    try { return callback.apply(this, args); }
    finally {
      depth--;
      const end = performance.now();
      if (scanner.windows.length < 40000) scanner.windows.push({ kind, start, end });
      else scanner.dropped++;
      scanner.byKind[kind] = (scanner.byKind[kind] || 0) + (end - start);
      scanner.calls[kind] = (scanner.calls[kind] || 0) + 1;
    }
  };
  for (const [name, kind] of [["MutationObserver", "mutation"], ["ResizeObserver", "resize"]]) {
    const Native = window[name];
    window[name] = class extends Native {
      constructor(callback) { super(scannerRegistered() ? scannerCallback(kind, callback) : callback); }
    };
  }
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback =>
    nativeFrame(scannerRegistered() ? scannerCallback("frame", callback) : callback);
  const nativeTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, ...rest) => nativeTimeout(
    typeof callback === "function" && scannerRegistered() ? scannerCallback("timer", callback) : callback, ...rest);
  // Listener identity must survive the wrapper: the scanner removes its own listeners by
  // reference in stop(), so removeEventListener resolves the same wrapper from this map. The map
  // is keyed by listener AND type, because the scanner registers one navigation function for
  // both popstate and cfg.navEvent, and each delivery must be labelled under its own type.
  const wrappedListeners = new WeakMap();
  const wrapListener = (type, listener) => {
    let byType = wrappedListeners.get(listener);
    if (!byType) { byType = new Map(); wrappedListeners.set(listener, byType); }
    let fn = byType.get(type);
    if (!fn) { fn = scannerCallback("event:" + type, listener); byType.set(type, fn); }
    return fn;
  };
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (typeof listener !== "function" || !scannerRegistered()) return nativeAdd.call(this, type, listener, options);
    return nativeAdd.call(this, type, wrapListener(type, listener), options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const fn = typeof listener === "function" ? wrappedListeners.get(listener)?.get(type) : undefined;
    return nativeRemove.call(this, type, fn ?? listener, options);
  };
  // MessagePort delivers through an onmessage PROPERTY assignment, which no addEventListener
  // override can see, and that is how the scanner's post-frame task (host.postTask) arrives.
  // Wrap the setter; the native setter still runs, so its implicit port.start() is unchanged.
  const portOnMessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  Object.defineProperty(MessagePort.prototype, "onmessage", {
    configurable: true, enumerable: portOnMessage.enumerable, get: portOnMessage.get,
    set(listener) {
      portOnMessage.set.call(this, typeof listener === "function" && scannerRegistered()
        ? scannerCallback("port", listener) : listener);
    }
  });
  const reads = new WeakMap(), originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const rect = originalRect.call(this);
    reads.set(this, { at: performance.now(), rect: rect.toJSON() });
    return rect;
  };
  const originalSet = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === "data-jev" || name === "data-jev-held") {
      const owner = this.closest("[data-qa-id]");
      if (owner) {
        const write = { id: owner.getAttribute("data-qa-id"), attribute: name,
        old: this.getAttribute(name), value: String(value), at: performance.now(), frame: m.frame,
        inScannerCallback: depth > 0, connected: this.isConnected, harness: m.harnessWrite === true,
        expect: owner.getAttribute("data-qa-expect"), model: owner.getAttribute("data-qa-model"),
        paintVisibleToAPI: performance.getEntriesByType("paint").length > 0,
        lastRectRead: reads.get(this) ?? null, viewportHeight: innerHeight, via: null };
        m.treatments.push(write);
        // The scanner records its apply path immediately AFTER the attribute write.
        queueMicrotask(() => { write.via = window.__JEV_QA__?.applyPaths?.get(this) ?? null; });
      }
    }
    return originalSet.call(this, name, value);
  };
  const originalRemove = Element.prototype.removeAttribute;
  Element.prototype.removeAttribute = function (name) {
    if ((name === "data-jev" || name === "data-jev-held") && this.hasAttribute(name)) {
      const owner = this.closest("[data-qa-id]");
      if (owner) {
        const write = { id: owner.getAttribute("data-qa-id"), attribute: name,
        old: this.getAttribute(name), value: null, at: performance.now(), frame: m.frame,
        inScannerCallback: depth > 0, connected: this.isConnected, harness: m.harnessWrite === true,
        expect: owner.getAttribute("data-qa-expect"), model: owner.getAttribute("data-qa-model"),
        paintVisibleToAPI: performance.getEntriesByType("paint").length > 0,
        lastRectRead: reads.get(this) ?? null, viewportHeight: innerHeight, via: null };
        m.treatments.push(write);
        queueMicrotask(() => { write.via = window.__JEV_QA__?.applyPaths?.get(this) ?? null; });
      }
    }
    return originalRemove.call(this, name);
  };
  addEventListener("error", e => m.errors.push(String(e.message || ("Resource: " + e.target?.src))));
  addEventListener("unhandledrejection", e => m.errors.push("Unhandled rejection: " + String(e.reason)));
  new PerformanceObserver(() => dispatchEvent(new Event("qa-progress")))
    .observe({ type: "paint", buffered: true });
  for (const type of ["layout-shift", "longtask"]) {
    const observer = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (type === "layout-shift") m.shifts.push({ value: e.value, recent: e.hadRecentInput, at: e.startTime,
          sources: e.sources?.map(s => ({ id: s.node?.getAttribute?.("data-qa-id"),
            itemId: s.node?.closest?.("[data-qa-id]")?.getAttribute("data-qa-id") ?? null,
            tag: s.node?.nodeName, testId: s.node?.getAttribute?.("data-testid") ?? null,
            selfAction: s.node?.getAttribute?.("data-jev") ?? null,
            ownerAction: s.node?.closest?.("[data-qa-id]")?.getAttribute("data-jev") ?? null,
            previous: s.previousRect.toJSON(), current: s.currentRect.toJSON(),
            deltaX: s.currentRect.x - s.previousRect.x, deltaY: s.currentRect.y - s.previousRect.y })) });
        else m.longtasks.push({ duration: e.duration, at: e.startTime });
      }
    });
    observer.observe({ type, buffered: true });
  }
  const IO = window.IntersectionObserver;
  window.IntersectionObserver = class extends IO {
    constructor(callback, options) {
      const inner = scannerRegistered() ? scannerCallback("intersection", callback) : callback;
      super((entries, observer) => {
        inner(entries, observer);
        for (const e of entries) {
          const el = e.target, id = el.getAttribute("data-qa-id");
          if (id && !m.first[id] && el.getAttribute("data-qa-expect") !== "keep") {
            m.first[id] = { height: e.boundingClientRect.height, top: e.boundingClientRect.top,
              kind: el.getAttribute("data-qa-kind"), channel: el.getAttribute("data-qa-channel"),
              via: window.__JEV_QA__?.applyPaths?.get(el) ?? null };
          }
        }
        dispatchEvent(new Event("qa-progress"));
      }, options);
    }
  };
})();`;

// Browser-side drivers use native events, not fixed sleeps or repeated host-side evaluation.
// The one-second idle case waits for the fixture's ro-idle insertion, not for elapsed time.
const drivers = String.raw`(() => {
  const Q = window.Q = {};
  Q.failures = [];
  // Set by a scenario that DELIBERATELY re-lays the page out (todo 29's stranded-prompt cases).
  // Shifts at or after this timestamp are the harness's own and are reported as harnessShift;
  // the extension's shift is still asserted to be zero for everything before it. Default 0 = off.
  Q.relayoutFrom = 0;
  Q.scrollUpCases = [];
  Q.history = new Map();
  Q.warningDepth = [];
  Q.preflights = [];
  Q.preflight = (phase, rows) => {
    const groups = new Map();
    for (const row of rows || Q.items().map(el => ({ id: el.getAttribute("data-qa-id"),
      descriptor: __JEV_QA_SRC__.descriptorOf(el, __JEV_QA_SITE__),
      groundTruth: { expect: el.getAttribute("data-qa-expect"), model: el.getAttribute("data-qa-model") } }))) {
      const descriptor = row.descriptor;
      const members = groups.get(descriptor.key) || [];
      members.push({ id: row.id, expect: row.groundTruth.expect, model: row.groundTruth.model, descriptor });
      groups.set(descriptor.key, members);
    }
    const mixed = [...groups].filter(([key, members]) => members.some(e => e.expect === "keep") && members.some(e => e.model))
      .map(([key, members]) => ({ key, members }));
    Q.preflights.push({ phase, at: performance.now(), groups: groups.size, mixed });
    if (mixed.length) throw new Error("FIXTURE_ORACLE_COLLISION: keep and data-qa-model share a signalKey: " + JSON.stringify(mixed));
  };
  Q.snapshot = phase => {
    const liveRows = [];
    for (const el of Q.items()) {
      const id = el.getAttribute("data-qa-id"), row = Q.history.get(id);
      const groundTruth = { expect: el.getAttribute("data-qa-expect"), model: el.getAttribute("data-qa-model"),
        kind: el.getAttribute("data-qa-kind"), channel: el.getAttribute("data-qa-channel") };
      const descriptor = row && row.groundTruth.kind === groundTruth.kind ? row.descriptor :
        __JEV_QA_SRC__.descriptorOf(el, __JEV_QA_SITE__);
      const observation = { at: performance.now(), phase, action: Q.action(el), held: Q.target(el).hasAttribute("data-jev-held") };
      if (!row) Q.history.set(id, { id, descriptor, groundTruth, first: observation, latest: observation });
      else { row.descriptor = descriptor; row.groundTruth = groundTruth; row.latest = observation; }
      liveRows.push(Q.history.get(id));
    }
    Q.preflight(phase, liveRows);
  };
  Q.depth = label => Q.warningDepth.push({ label, at: performance.now(), scrollY,
    items: Q.items().length, warnings: __QA_METRICS__.errors.filter(e =>
      e.includes("ResizeObserver loop completed with undelivered notifications")).length });
  Q.assert = (condition, label, actual) => {
    if (!condition) Q.failures.push({ label, actual });
  };
  Q.items = () => [...document.querySelectorAll("[data-qa-expect]")];
  Q.target = el => {
    const selectors = __JEV_QA_SRC__.modules;
    return el.matches(selectors) ? el : el.querySelector(selectors) || el;
  };
  Q.action = el => Q.target(el).getAttribute("data-jev");
  Q.wait = (test, label, trigger, timeout = 8000) => new Promise((resolve, reject) => {
    const mo = new MutationObserver(check);
    const timer = setTimeout(() => {
      cleanup(); reject(new Error("Timed out: " + label));
    }, timeout);
    function cleanup() { clearTimeout(timer); mo.disconnect(); removeEventListener("qa-progress", check); }
    function check() {
      try { if (test()) { cleanup(); resolve(true); } }
      catch (e) { cleanup(); reject(e); }
    }
    mo.observe(document, { childList: true, subtree: true, attributes: true });
    addEventListener("qa-progress", check);
    if (trigger) trigger();
    check();
  });
  Q.frame = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out: rendering update")), 8000);
    requestAnimationFrame(() => {
      const c = new MessageChannel();
      c.port1.onmessage = () => {
        c.port1.close(); c.port2.close(); clearTimeout(timer); resolve(true);
      };
      c.port2.postMessage(null);
    });
  });
  Q.painted = () => Q.wait(() => performance.getEntriesByType("paint").some(e => e.name === "first-paint"),
    "first-paint entry publication");
  Q.ready = async () => {
    await Q.wait(() => window.__fx && (new URLSearchParams(location.search).has("clean") || window.__JEV_QA__), "fixture and scanner");
    await Q.frame();
    Q.snapshot("ready");
    Q.runStart = performance.now();
  };
  Q.models = async (fail = false) => {
    await Q.wait(() => fail ? __QA_SHIM__.answers.length > 0 :
      Q.items().filter(el => el.hasAttribute("data-qa-model")).every(el => {
        const key = __JEV_QA_SRC__.keyOf(el, __JEV_QA_SITE__);
        return __QA_SHIM__.answers.some(a => a.keys.includes(key));
      }), "model response");
    await Q.frame(); await Q.frame();
  };
  Q.storage = async () => {
    await Q.wait(() => __QA_SHIM__.storageLog.length >= 2 &&
      __QA_SHIM__.storageLog.every(e => e.resolvedAt >= 0), "storage resolution");
    await Q.frame();
  };
  Q.step = async (delta, bottom = false) => {
    const previous = new Map(Q.items().map(el => [el, { id: el.getAttribute("data-qa-id"), action: Q.action(el) }]));
    const el = Q.items().find(el => el.getAttribute("data-qa-expect") === "keep" &&
      el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().bottom > 0 &&
      el.getBoundingClientRect().top < innerHeight);
    const top = el?.getBoundingClientRect().top, y = scrollY;
    // Native scroll anchoring can conceal extension-induced layout changes. Do not disable it.
    scrollTo(0, bottom ? document.documentElement.scrollHeight : y + delta);
    await Q.frame();
    await Q.frame();
    const distance = scrollY - y;
    const shift = el && el.isConnected ? Math.abs(el.getBoundingClientRect().top - top + distance) : 0;
    __QA_METRICS__.anchors.push({ id: el?.getAttribute("data-qa-id"), shift, distance });
    Q.assert(shift <= .5, "anchor shift <= 0.5px", { shift, distance });
    if (delta < 0 && !bottom && window.__JEV_QA__) {
      for (const item of Q.items()) {
        const old = previous.get(item);
        if (item.getAttribute("data-qa-channel") !== "recycle-up" ||
            old?.id === item.getAttribute("data-qa-id") || old?.action === "hide") continue;
        const write = __QA_METRICS__.treatments.findLast(w => w.id === item.getAttribute("data-qa-id") && w.attribute === "data-jev");
        // The fixture can attempt a recycle-up but return the cell to its below-fold tail.
        // Those are correctly hidden, not an above-viewport placement case.
        if (write?.lastRectRead?.rect.top >= write?.viewportHeight) continue;
        const actual = item.getAttribute("data-jev");
        Q.scrollUpCases.push({ id: item.getAttribute("data-qa-id"), before: old?.action, actual });
        Q.assert(actual === "blur", "newly recycled visible scroll-up ad blurs", item.outerHTML);
      }
    }
    Q.snapshot("scroll");
  };
  Q.growth = async () => {
    const counts = [Q.items().length];
    for (let i = 0; i < 2; i++) {
      const before = Q.items().length;
      try {
        await Q.wait(() => Q.items().length > before, "bottom scroll grows fixture", () => {
          scrollTo(0, document.documentElement.scrollHeight);
        }, 4000);
      } catch (e) {
        Q.assert(false, "bottom scroll growth completed", String(e));
      }
      await Q.frame();
      counts.push(Q.items().length);
    }
    Q.assert(counts[1] > counts[0] && counts[2] > counts[1], "two successive growths", counts);
    return counts;
  };
  Q.probe = async (channel, invoke) => {
    const prior = new Set(Object.keys(__fx.ioFirst));
    await Q.wait(() => Object.entries(__fx.ioFirst).some(([id,e]) => e.channel === channel && !prior.has(id)), channel + " first frame", invoke);
    const items = Q.items().filter(el => el.getAttribute("data-qa-channel") === channel &&
      el.getAttribute("data-qa-expect") === "hide");
    Q.assert(items.length > 0, channel + " has deterministic probe", items.length);
    for (const el of items) {
      const id = el.getAttribute("data-qa-id"), first = __fx.ioFirst[id], metric = __QA_METRICS__.first[id];
      Q.assert(first && first.height === 0, channel + " same-frame hide " + id, first);
      const via = channel.startsWith("ro") || channel === "raf-probe" ? "mutation" : "ro";
      Q.assert(metric?.via === via, channel + " per-item apply path " + id, metric);
    }
  };
  Q.validate = (excluded = false, fail = false) => {
    const items = Q.items();
    for (const el of items) {
      const id = el.getAttribute("data-qa-id"), expect = el.getAttribute("data-qa-expect");
      const action = Q.action(el);
      if (excluded || expect === "keep") {
        const heldRecycle = !excluded && el.hasAttribute("data-jev-held") &&
          ["recycle", "held-probe"].includes(el.getAttribute("data-qa-channel"));
        Q.assert(!action || heldRecycle, "keep unmarked " + id, action);
      } else if (fail && el.hasAttribute("data-qa-model")) {
        Q.assert(!action, "429 leaves model item untouched " + id, action);
      } else Q.assert(action === "hide" || action === "blur", "treated item " + id, action);
    }
    Q.assert(excluded ? __JEV_QA__.processed === 0 : __JEV_QA__.processed >= items.length,
      "processed count", { processed: __JEV_QA__.processed, items: items.length });
    Q.assert(!__QA_SHIM__.calls.some(c => c.json.includes("BODY_SENTINEL")), "no body text on wire", __QA_SHIM__.calls.length);
    if (excluded) Q.assert(document.querySelectorAll("[data-jev]").length === 0, "messages has no marked elements");
  };
  Q.checkWarnings = async () => {
    const count = () => __QA_METRICS__.errors.filter(e =>
      e.includes("ResizeObserver loop completed with undelivered notifications")).length;
    const idleCounts = [count()];
    await Q.frame(); idleCounts.push(count());
    await Q.frame(); idleCounts.push(count());
    const roTreatmentWrites = __QA_METRICS__.treatments.filter(w =>
      w.attribute === "data-jev" && (w.value === "hide" || w.value === "blur") && w.via === "ro").length;
    const boundPassed = count() <= roTreatmentWrites;
    const idlePassed = idleCounts.every(n => n === idleCounts[0]);
    Q.assert(boundPassed, "RO warnings <= ro-path treatment writes", { count:count(), roTreatmentWrites });
    Q.assert(idlePassed, "RO warnings stable across two idle barriers", idleCounts);
    return { count:count(), roTreatmentWrites, idleCounts, boundPassed, idlePassed };
  };
  Q.report = async () => {
    await Q.painted();
    const warningAssertions = await Q.checkWarnings();
    Q.snapshot("report");
    const m = __QA_METRICS__, durations = [...(window.__JEV_QA__?.callbackDurations || [])].sort((a,b) => a-b);
    const warnings = m.errors.filter(e => e.includes("ResizeObserver loop completed with undelivered notifications"));
    const errors = m.errors.filter(e => !e.includes("ResizeObserver loop completed with undelivered notifications"));
    // Read startTime at run end: Chrome can publish the paint entry 1-2 frames late.
    const paint = performance.getEntriesByType("paint").map(e => ({name:e.name, at:e.startTime}));
    const firstPaint = paint.find(e => e.name === "first-paint")?.at;
    Q.assert(firstPaint !== undefined, "first-paint timestamp available", paint);
    // Pre-paint exclusion is safe ONLY with the mandatory first-painted-frame no-flash probes.
    // If those probes are removed, this exclusion must be removed with them.
    const prePaintEntries = m.shifts.filter(e => firstPaint !== undefined && e.at < firstPaint);
    const excludedPrePaint = { count:prePaintEntries.length, sum:prePaintEntries.reduce((sum,e) => sum+e.value, 0) };
    const counted = m.shifts.filter(e => !e.recent && (firstPaint === undefined || e.at >= firstPaint));
    const shift = counted.filter(e => Q.relayoutFrom === 0 || e.at < Q.relayoutFrom).reduce((sum,e) => sum+e.value, 0);
    const harnessShift = counted.filter(e => Q.relayoutFrom !== 0 && e.at >= Q.relayoutFrom).reduce((sum,e) => sum+e.value, 0);
    Q.assert(errors.length === 0, "no page errors or unhandled rejections", errors);
    Q.assert(shift === 0, "layout-shift total is zero", m.shifts);
    // A long task measures the HOST, not the extension: F3, the todo 16 phase-1 run and the
    // wave-4 gate each failed "no long task > 50ms" while the scanner's own longest callback in
    // that run was 1.3-3.5 ms, and extension-free controls - which load no extension at all -
    // hit it too. So attribute it: the beforeNavigation wrappers give every scanner callback an
    // exact window, and a long task is the scanner's only when the scanner's own work inside it
    // is itself long-task sized (> 50 ms). Every other long task is a non-failing diagnostic with
    // its duration, time, overlap and the apply writes it contains. Nothing is relaxed: the
    // attributable budget (callback p95 <= 4 ms, max <= 16 ms) is asserted below, unchanged.
    const extensionFree = !window.__JEV_QA__;
    const attribute = task => {
      const from = task.at, to = task.at + task.duration;
      const parts = [];
      let scannerMs = 0;
      for (const w of m.scanner.windows) {
        const lo = Math.max(w.start, from), hi = Math.min(w.end, to);
        if (hi <= lo) continue;
        scannerMs += hi - lo;
        parts.push({ kind: w.kind, start: w.start, end: w.end, overlap: hi - lo });
      }
      const writes = m.treatments.filter(w => w.at >= from && w.at <= to);
      const duringRun = task.at >= Q.runStart;
      return { duration: task.duration, at: task.at, end: to, duringRun, scannerMs,
        scannerCallbacks: parts.length, applyWrites: writes.length,
        overlapping: [...parts].sort((a,b) => b.overlap - a.overlap).slice(0, 8),
        writes: writes.slice(0, 8).map(w => ({ id: w.id, attribute: w.attribute, value: w.value, at: w.at,
          via: w.via, inScannerCallback: w.inScannerCallback })),
        attributed: !extensionFree && duringRun && scannerMs > 50 };
    };
    const annotatedLongtasks = m.longtasks.map(attribute);
    const runLongtasks = annotatedLongtasks.filter(e => e.duringRun);
    const attributedLongtasks = annotatedLongtasks.filter(e => e.attributed);
    Q.assert(attributedLongtasks.length === 0, "no long task > 50ms overlapping scanner work", attributedLongtasks);
    // The apply-write clause of the todo, as an ASSERTION rather than an audit. Promise
    // continuations (post-send, post-settings, post-cache, updateCache) are the one scanner entry
    // point no registration wrapper can see, and they do real O(n) work; the long-task rule cannot
    // attribute a stall inside them. This closes that hole from the other side: all treatment work
    // must reach the DOM from inside a wrapped scanner callback, so the day a change starts writing
    // data-jev from a continuation, the run fails here instead of going unnoticed.
    // Two exclusions, both narrow and deliberate:
    //   - a DETACHED node: the harness's own cache-probe clone, stripped of the source item's
    //     data-jev before it is given its own data-qa-id, so it is never in the document;
    //   - harness: the drivers' OWN deliberate writes, which set __QA_METRICS__.harnessWrite
    //     around them (the forced-hide control, which must keep failing on shift alone).
    const unwrappedWrites = m.treatments.filter(w => w.connected && !w.harness && !w.inScannerCallback);
    Q.assert(unwrappedWrites.length === 0, "every apply write happens inside a scanner callback",
      unwrappedWrites.map(w => ({ id: w.id, attribute: w.attribute, before: w.old, after: w.value,
        at: w.at, via: w.via, connected: w.connected })));
    const longTaskDiagnostics = { longTaskThreshold: 50, scannerOverlapThreshold: 50, extensionFree,
      scannerWindows: m.scanner.windows.length, scannerWindowsDropped: m.scanner.dropped,
      scannerCallsByKind: m.scanner.calls, scannerMsByKind: m.scanner.byKind,
      applyWrites: { total: m.treatments.length,
        insideScannerCallback: m.treatments.filter(w => w.inScannerCallback).length,
        unwrapped: unwrappedWrites.length,
        outsideScannerCallback: m.treatments.filter(w => !w.inScannerCallback).map(w =>
          ({ id: w.id, attribute: w.attribute, value: w.value, at: w.at, via: w.via,
            connected: w.connected, harness: w.harness })) },
      attributed: attributedLongtasks, unattributed: runLongtasks.filter(e => !e.attributed),
      beforeRun: annotatedLongtasks.filter(e => !e.duringRun) };
    const p95 = durations[Math.max(0, Math.ceil(durations.length*.95)-1)] || 0;
    const max = durations.at(-1) || 0;
    Q.assert(p95 <= 4, "MO callback p95 <= 4ms", p95);
    if (location.pathname.includes("stress")) Q.assert(max <= 16, "stress MO callback max <= 16ms", max);
    const byKey = {}, itemTable = [...Q.history.values()];
    for (const row of itemTable) {
      if (row.groundTruth.kind === "module" || row.groundTruth.kind === "dm") continue;
      const group = byKey[row.descriptor.key] ||= { key: row.descriptor.key, members: [], model: [], keep: [], mustTreat: [], mistreatedKeep: [] };
      group.members.push(row.id);
      if (row.groundTruth.model) group.model.push(row.id);
      if (row.groundTruth.expect === "keep") {
        group.keep.push(row.id);
        if (row.latest.action && !row.latest.held) group.mistreatedKeep.push({ id: row.id, action: row.latest.action });
      } else group.mustTreat.push(row.id);
    }
    const collisionGroups = Object.values(byKey).filter(g => g.members.length > 1)
      .map(g => ({ ...g, classification: g.keep.length && g.mustTreat.length ? "mixed-ground-truth" : "by-design-uniform" }));
    const layoutEntries = m.shifts.map(e => ({ ...e,
      hadRecentInput: e.recent, relativeToFirstPaint: firstPaint === undefined ? null : e.at - firstPaint,
      excludedPrePaint: firstPaint !== undefined && e.at < firstPaint }));
    const treatmentWrites = m.treatments.map(e => ({ ...e,
      relativeToFirstPaint: firstPaint === undefined ? null : e.at - firstPaint,
      inViewportAtLastRead: e.lastRectRead ? e.lastRectRead.rect.top < e.viewportHeight && e.lastRectRead.rect.bottom > 0 : null }));
    const adjudication = {
      finding1: {
        mixedGroundTruth: collisionGroups.filter(g => g.classification === "mixed-ground-truth"),
        uniformGroupCount: collisionGroups.filter(g => g.classification === "by-design-uniform").length,
        mistreatedKeep: collisionGroups.flatMap(g => g.mistreatedKeep),
        mixedOraclePreflights: Q.preflights.filter(p => p.mixed.length)
      },
      finding2: { cumulative: shift, excludedPrePaint, paint, entries: layoutEntries,
        writes: treatmentWrites.map(w => ({ id:w.id, attribute:w.attribute, before:w.old, after:w.value,
          at:w.at, frame:w.frame, afterFirstPaint:w.relativeToFirstPaint,
          paintVisibleToAPI:w.paintVisibleToAPI, rectTop:w.lastRectRead?.rect.top ?? null,
          rectBottom:w.lastRectRead?.rect.bottom ?? null, rectReadAt:w.lastRectRead?.at ?? null,
          inViewport:w.inViewportAtLastRead })),
        storage: __QA_SHIM__.storageLog },
      warningDepth: Q.warningDepth
    };
    return { failures: Q.failures, processed: window.__JEV_QA__?.processed ?? 0, items: Q.items().length,
      shift, harnessShift, relayoutFrom: Q.relayoutFrom,
      maxAnchorShift: Math.max(0,...m.anchors.map(e => e.shift)), p95, maxCallback: max,
      warnings, warningAssertions, errors, runStart: Q.runStart, longtasks: m.longtasks, runLongtasks,
      longTaskDiagnostics, anchors: m.anchors,
      paint, firstPaint:firstPaint ?? null, excludedPrePaint, layoutEntries, collisionGroups, itemTable,
      warningDepth: Q.warningDepth, preflights: Q.preflights, adjudication,
      cacheSnapshot: __QA_SHIM__.snapshot()[__JEV_QA_SRC__.sigKey(__JEV_QA_SITE__)] ?? null,
      treatments: treatmentWrites, scrollUpCases: Q.scrollUpCases, firstFrames: __fx.ioFirst, applyPaths: m.first,
      calls: __QA_SHIM__.calls, answers: __QA_SHIM__.answers };
  };
})();`;

type CollisionGroup = {
  readonly key: string;
  readonly members: readonly string[];
  readonly keep: readonly string[];
  readonly model: readonly string[];
};
type CacheSnapshot = {
  readonly day: string;
  readonly providerKey: string;
  readonly entries: Record<string, unknown>;
  readonly order?: readonly string[];
};
type BrowserReport = {
  readonly failures: readonly unknown[];
  readonly shift: number;
  readonly maxAnchorShift: number;
  /** todo 29: the stored user answers after the scenario answered a prompt, and the key it answered. */
  readonly overrideSnapshot?: unknown;
  readonly overrideKey?: string;
  readonly collisionGroups?: readonly CollisionGroup[];
  readonly firstPaint: number | null;
  readonly excludedPrePaint: { readonly count: number; readonly sum: number };
  readonly warnings: readonly string[];
  readonly cacheSnapshot?: unknown;
  readonly adjudication?: unknown;
  readonly longTaskDiagnostics?: LongTaskDiagnostics;
  readonly warningAssertions: {
    readonly count: number;
    readonly roTreatmentWrites: number;
    readonly idleCounts: readonly number[];
    readonly boundPassed: boolean;
    readonly idlePassed: boolean;
    readonly controlZero?: boolean | null;
    readonly controlStatus?: ControlStatus;
    readonly controlWarnings?: number;
  };
};
type LongTask = { readonly duration: number; readonly at: number; readonly scannerMs: number };
type LongTaskDiagnostics = {
  readonly extensionFree: boolean;
  readonly scannerWindows: number;
  readonly scannerMsByKind: Record<string, number>;
  readonly attributed: readonly LongTask[];
  readonly unattributed: readonly LongTask[];
  readonly beforeRun: readonly LongTask[];
};
/** "not-executed": a fixture/mode filter excluded the extension-free control from this run. */
type ControlStatus = "zero" | "nonzero" | "errored" | "not-executed";
type Scenario = {
  readonly name: string; readonly query?: string; readonly path?: string; readonly code: string;
  /** Writes `<fixture>.<file>.png` after the scenario returns, with whatever is still on screen. */
  readonly screenshot?: string;
};
type ScenarioReport = { readonly name: string; readonly report?: BrowserReport; readonly error?: string };

const baseline = String.raw`
  await Q.ready();
  const messages = location.pathname === "/messages";
  if (!messages) await Q.models();
  Q.depth("before-scroll");
  for (let i=0; i<30; i++) {
    await Q.step(i >= 20 && __fx.site === "x" ? -400 : 400);
    if ((i+1)%10 === 0) Q.depth("step-" + (i+1));
  }
  const growth = await Q.growth();
  if (!messages) {
    await Q.models();
    await Q.probe("scroll-probe", () => __fx.append(["adAttr", "organic"], "scroll-probe"));
    await Q.probe("raf-probe", () => __fx.rafInsert(["adLabel", "organic"], "raf-probe"));
    await Q.probe("ro-active", () => {
      __fx.append(["organic"], "active-target");
      __fx.roInsert(["adAttr", "organic"], "ro-active");
    });
    await Q.probe("ro-idle", () => {
      // Fixture emits this insertion after scroll stops; subscribe before triggering scroll.
      scrollBy(0, -1);
    });
    // Previously-classified unknown skeleton: a first-frame cache hit, not a second model answer.
    const before = __QA_SHIM__.calls.length;
    const positiveKeys = new Set(__QA_SHIM__.answers.flatMap(a => a.keys.filter((key,i) => a.res.scores?.[i]?.suggested === .9)));
    const source = Q.items().find(e => e.hasAttribute("data-qa-model") &&
      positiveKeys.has(__JEV_QA_SRC__.keyOf(e, __JEV_QA_SITE__)));
    Q.assert(!!source, "cache probe has an earlier positive source", [...positiveKeys]);
    let cached;
    if (source) {
      cached = source.cloneNode(true);
      cached.removeAttribute("data-jev"); cached.removeAttribute("data-jev-held");
      cached.setAttribute("data-qa-id","cache-probe");
      cached.setAttribute("data-qa-channel","cache-probe");
      if (__fx.site === "x") cached.style.transform = "translateY(" + (document.documentElement.scrollHeight + 1000) + "px)";
      const observer = new IntersectionObserver(entries => {
        for (const e of entries) if (!__fx.ioFirst["cache-probe"]) __fx.ioFirst["cache-probe"] = {
          kind:"unknown", expect:"blur-or-hide", channel:"cache-probe", height:e.boundingClientRect.height,
          top:e.boundingClientRect.top, jev:e.target.getAttribute("data-jev"), t:performance.now() };
      }, {rootMargin:"100000px"});
      await Q.wait(() => __fx.ioFirst["cache-probe"], "cached first frame", () => {
        observer.observe(cached); document.querySelector("[data-qa-feed]").append(cached);
      });
      observer.disconnect();
    }
    Q.assert(!!cached, "cache probe uses an earlier positive signalKey", [...positiveKeys]);
    if (cached) {
      const first = __fx.ioFirst[cached.getAttribute("data-qa-id")];
      Q.assert(first.height === 0, "cache-hit first frame hidden", first);
      Q.assert(__QA_METRICS__.first[cached.getAttribute("data-qa-id")]?.via === "ro", "cache-hit apply path");
    }
    Q.assert(__QA_SHIM__.calls.length === before, "cached insertion makes no request");
    for (const [id, first] of Object.entries(__fx.ioFirst)) {
      if (["adAttr","adLabel","suggestedLabel","suggestedFollow"].includes(first.kind) &&
          ["initial","scroll","raf","ro","ro-idle"].includes(first.channel)) {
        const write = __QA_METRICS__.treatments.find(w => w.id === id && w.attribute === "data-jev");
        const top = write?.lastRectRead?.rect.top ?? first.top;
        const eligible = first.channel === "initial" || write?.paintVisibleToAPI === false || top >= innerHeight;
        Q.assert(eligible ? first.height === 0 : first.jev === "blur", "first frame deterministic " + id,
          { ...first, originalTop:top, eligibleForHide:eligible });
        const via = __QA_METRICS__.first[id]?.via;
        // Scroll events themselves can execute within a rendering update. Both scanner paths
        // are valid there; the task-insertion and site-rAF/RO probes above assert exact paths.
        Q.assert(["raf","ro","ro-idle"].includes(first.channel) ? via === "mutation" :
          via === "ro" || via === "mutation", "via channel " + id, __QA_METRICS__.first[id]);
      }
    }
    if (__fx.site === "x") {
      Q.assert(Q.scrollUpCases.length > 0, "scroll-up actually recycles an unhidden cell", Q.scrollUpCases);
    }
  }
  Q.validate(messages);
  Q.depth("after-growth-and-probes");
  return { ...await Q.report(), growth };`;

// One poisoned MODEL verdict on the fixture's own dominant organic skeleton: the cap must bound
// how many items it ever treats, while the real ads (a group under the cap) stay treated.
const poisonedCacheCap = String.raw`
  await Q.ready(); await Q.storage(); await Q.frame();
  const poisoned = new URLSearchParams(location.search).get("poisonedKey");
  const mine = () => Q.items().filter(el => __JEV_QA_SRC__.keyOf(el, __JEV_QA_SITE__) === poisoned);
  Q.assert(__QA_SHIM__.calls.length === 0, "seeded cache answers every key without a request", __QA_SHIM__.calls.length);
  Q.depth("before-scroll");
  for (let i = 0; i < 30; i++) {
    await Q.step(400);
    if ((i+1)%10 === 0) Q.depth("step-" + (i+1));
  }
  const observed = __JEV_QA__.observedItems;
  const cap = __JEV_QA_SRC__.modelGroupCap(observed);
  const group = mine();
  const treated = group.filter(el => Q.action(el) || el.hasAttribute("data-jev-held"));
  const ads = Q.items().filter(el => el.hasAttribute("data-qa-model"));
  const nonModule = Q.items().filter(el => el.getAttribute("data-qa-kind") !== "module").length;
  Q.assert(group.length > cap, "poisoned group is larger than the cap", { group:group.length, cap, observed });
  // Both bounds. An upper bound alone cannot fail on under-treatment: the attempt-1 cap held 33 of
  // a 293 group under a cap of 40 and passed, which was the blocking defect. The cap grows with its
  // denominator, so the charge count converges to it from below - one more slot opens every
  // 1/MODEL_GROUP_SHARE observed items, and the tail of a run observes items of other keys. Two
  // such increments of slack; the measured lag is 2.
  const slack = Math.round(2 / __JEV_QA_SRC__.MODEL_GROUP_SHARE);
  Q.assert(treated.length <= Math.min(cap, group.length) && treated.length >= Math.min(cap, group.length) - slack,
    "the poisoned verdict holds the cap, within the convergence slack",
    { treated:treated.length, cap, slack, group:group.length, observed, key:poisoned });
  Q.assert(group.length - treated.length > 0, "items past the cap are left untouched",
    { untouched:group.length - treated.length });
  // The cap must not silence real ads: their group stays far under it by construction.
  Q.assert(ads.length > 0 && ads.every(el => Q.action(el)), "every real ad is still treated",
    { ads:ads.length, untreated:ads.filter(el => !Q.action(el)).length });
  Q.assert(observed >= nonModule, "scanner observed every non-module fixture item", { observed, nonModule });
  Q.depth("after-scroll");
  const report = await Q.report();
  return { ...report, poisonedCap: { key:poisoned, cap, observed, group:group.length, treated:treated.length,
    ads:ads.length, shift:report.shift, maxAnchorShift:report.maxAnchorShift } };`;

// todo 29: the user answer prompt on a model-blurred item. `arrange=model` puts one unknown item
// inside the viewport and its exact clone at the feed's end, so both share one signalKey:
// `holdClassify=1` then keeps the verdict until after first paint, which is the blur case.
// answer=no|yes answers the prompt; an absent answer leaves it up for the screenshot.
const overlayPrompt = String.raw`
  await Q.ready();
  const answer = new URLSearchParams(location.search).get("answer") || "";
  const prompts = () => [...document.querySelectorAll("[data-jev-overlay]")];
  const item = document.querySelector("[data-qa-model]");
  const far = document.querySelector('[data-qa-id="reconcile-far"]');
  Q.assert(!!item && !!far && item !== far, "the fixture offers the model item and its far clone", !!far);
  await Q.frame();
  const style = item.getAttribute("style");
  const box = item.getBoundingClientRect();
  const child = item.firstElementChild;
  const childBox = child.getBoundingClientRect();
  Q.assert(box.top >= 0 && box.top < innerHeight, "the model item starts inside the viewport", box.top);
  Q.assert(far.getBoundingClientRect().top >= innerHeight, "its clone starts below the fold", far.getBoundingClientRect().top);
  Q.assert(prompts().length === 0, "no prompt before any verdict", prompts().length);
  // The verdict lands after first paint, so the placement rule blurs it in place.
  __QA_SHIM__.releaseClassify();
  await Q.models();
  const key = __JEV_QA_SRC__.keyOf(item, __JEV_QA_SITE__);
  Q.assert(key === __JEV_QA_SRC__.keyOf(far, __JEV_QA_SITE__), "both items share one signalKey");
  Q.assert(item.getAttribute("data-jev") === "blur", "the late model verdict blurs the painted item", item.getAttribute("data-jev"));
  Q.assert(far.getAttribute("data-jev") === "hide", "the same-key item below the fold is hidden", far.getAttribute("data-jev"));
  const deterministic = Q.items().filter(el => ["adAttr","adLabel","suggestedLabel","suggestedFollow"].includes(el.getAttribute("data-qa-kind")));
  const modules = Q.items().filter(el => el.getAttribute("data-qa-kind") === "module");
  Q.assert(deterministic.length > 0 && deterministic.every(el => Q.action(el) === "hide"), "deterministic items are hidden", deterministic.map(el => Q.action(el)));
  Q.assert(modules.length > 0 && modules.every(el => Q.action(el)), "modules are treated", modules.map(el => Q.action(el)));
  for (const el of Q.items()) {
    if (el.getAttribute("data-qa-expect") === "keep") Q.assert(!Q.action(el), "keep item untouched " + el.getAttribute("data-qa-id"), Q.action(el));
  }
  // Exactly one prompt, on the model-blurred item: so no hidden, deterministic or module item has one.
  const prompt = prompts()[0];
  Q.assert(prompts().length === 1 && prompt.getAttribute("data-jev-key") === key,
    "one prompt only, on the model-blurred item",
    { prompts: prompts().length, key, promptKey: prompt && prompt.getAttribute("data-jev-key"),
      hidden: Q.items().filter(el => Q.action(el) === "hide").length });
  // Isolation: outside every feed element, in its own shadow root, unaffected by the item's blur.
  Q.assert(!prompt.closest("[data-qa-expect]") && !item.contains(prompt), "the prompt is outside every feed element");
  Q.assert(!!prompt.shadowRoot && prompt.shadowRoot.querySelectorAll("style").length === 1, "the prompt carries its own styles in a shadow root");
  Q.assert(prompt.textContent === "", "nothing of the prompt leaks into the page tree", prompt.textContent);
  Q.assert(getComputedStyle(prompt).filter === "none" && getComputedStyle(prompt).opacity === "1", "the prompt is not blurred with the item",
    { filter: getComputedStyle(prompt).filter, opacity: getComputedStyle(prompt).opacity });
  // The item itself is untouched: same style attribute, same box, same containing block for its children.
  const after = item.getBoundingClientRect();
  Q.assert(item.getAttribute("style") === style, "the item's style attribute is untouched", item.getAttribute("style"));
  Q.assert(after.top === box.top && after.left === box.left && after.width === box.width && after.height === box.height,
    "the item's box is unchanged", { before: box.toJSON(), after: after.toJSON() });
  Q.assert(!item.querySelector("[data-jev-overlay]"), "the item gained no child");
  // The containing block of the item's own children is unchanged: they did not move either.
  const childAfter = child.getBoundingClientRect();
  Q.assert(childAfter.top === childBox.top && childAfter.left === childBox.left &&
    childAfter.width === childBox.width && childAfter.height === childBox.height,
    "the item's children did not move", { before: childBox.toJSON(), after: childAfter.toJSON() });
  const pr = prompt.getBoundingClientRect();
  Q.assert(pr.top >= after.top - 1 && pr.left >= after.left - 1 && pr.right <= after.right + 1,
    "the prompt sits inside the item's own box", { prompt: pr.toJSON(), item: after.toJSON() });
  const text = prompt.shadowRoot.textContent;
  const lang = document.documentElement.lang;
  Q.assert(text.includes(lang === "ko" ? "광고 맞아요?" : "Is this an ad?"), "the prompt speaks the page language", { lang, text });
  Q.assert(text.includes(lang === "ko" ? "아니오" : "No") && text.includes(lang === "ko" ? "예" : "Yes"), "both answers are offered", text);
  if (answer === "") return { ...await Q.report(), overlayPrompt: { key, lang, text, prompt: pr.toJSON(), item: after.toJSON() } };

  // Answering: nothing reaches the page, nothing reaches the network.
  const pageEvents = [];
  const spy = e => pageEvents.push(e.type);
  for (const type of ["click", "mousedown", "pointerdown", "keydown"]) document.addEventListener(type, spy);
  const callsBefore = __QA_SHIM__.calls.length;
  const hrefBefore = location.href;
  const button = prompt.shadowRoot.querySelector('[data-answer="' + answer + '"]');
  Q.assert(!!button, "the prompt offers the " + answer + " button");
  await Q.wait(() => !prompt.isConnected, "the prompt is dismissed", () => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, cancelable: true }));
    button.click();
  });
  await Q.frame(); await Q.frame();
  const stored = __QA_SHIM__.snapshot()[__JEV_QA_SRC__.overrideKey(__JEV_QA_SITE__)];
  const entry = stored && stored.entries ? stored.entries[key] : undefined;
  Q.assert(!!entry, "the answer is persisted under its signalKey", stored);
  Q.assert(entry.decision === (answer === "no" ? "keep" : "confirmed"), "the stored decision is the user's answer", entry);
  Q.assert(Object.keys(entry).sort().join(",") === "at,decision", "only a decision and a timestamp are stored", entry);
  Q.assert(typeof entry.at === "number" && entry.at > 0, "the answer carries a timestamp", entry);
  Q.assert(!JSON.stringify(stored).includes("BODY_SENTINEL"), "no page text is stored", stored);
  Q.assert(__QA_SHIM__.calls.length === callsBefore, "answering sends nothing", { callsBefore, now: __QA_SHIM__.calls.length });
  Q.assert(pageEvents.length === 0, "no event from the prompt reaches the page", pageEvents);
  Q.assert(location.href === hrefBefore, "answering never navigates");
  Q.assert(prompts().length === 0, "the answered prompt is gone", prompts().length);
  if (answer === "no") {
    await Q.wait(() => !item.hasAttribute("data-jev"), "the answered item is unblurred");
    Q.assert(!far.hasAttribute("data-jev"), "every same-key item on the page is released", far.getAttribute("data-jev"));
    Q.assert(!far.hasAttribute("data-jev-held"), "a released item below the fold is not merely held");
  } else {
    Q.assert(item.getAttribute("data-jev") === "blur", "yes keeps the treatment", item.getAttribute("data-jev"));
    Q.assert(far.getAttribute("data-jev") === "hide", "yes keeps the same-key item hidden", far.getAttribute("data-jev"));
  }
  Q.assert(deterministic.every(el => Q.action(el) === "hide"), "an answer never touches a deterministic verdict", deterministic.map(el => Q.action(el)));
  for (const type of ["click", "mousedown", "pointerdown", "keydown"]) document.removeEventListener(type, spy);
  return { ...await Q.report(), overrideSnapshot: stored, overrideKey: key };`;

// todo 29 attempt 2: a prompt must never be left standing over something it does not describe.
// Each run re-lays the page out in one way the page never reports to the scanner - content
// inserted above the item, the column narrowing as on a window resize, the item being detached -
// WITHOUT scrolling, and then requires that no prompt is stranded: every prompt still on screen
// must sit inside the item whose signalKey it carries, or be gone.
const overlayStranded = String.raw`
  await Q.ready();
  const prompts = () => [...document.querySelectorAll("[data-jev-overlay]")];
  const item = document.querySelector("[data-qa-model]");
  Q.assert(!!item, "the fixture offers a model item");
  await Q.frame();
  __QA_SHIM__.releaseClassify();
  await Q.models();
  const key = __JEV_QA_SRC__.keyOf(item, __JEV_QA_SITE__);
  const box = () => item.getBoundingClientRect();
  Q.assert(item.getAttribute("data-jev") === "blur", "the late model verdict blurs the painted item", item.getAttribute("data-jev"));
  Q.assert(prompts().length === 1, "the prompt is up before the page re-lays out", prompts().length);
  // A prompt still on screen must sit inside the item whose key it carries. One over another post
  // - or over the background - is the stranded case: answering it would persist a permanent
  // verdict for a skeleton the user never judged.
  const stranded = () => prompts().filter(host => {
    const r = host.getBoundingClientRect();
    const owner = Q.items().find(el => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 &&
        r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    });
    return !owner || __JEV_QA_SRC__.keyOf(owner, __JEV_QA_SITE__) !== host.getAttribute("data-jev-key");
  }).map(host => ({ key: host.getAttribute("data-jev-key"), rect: host.getBoundingClientRect().toJSON(),
    over: Q.items().filter(el => { const b = el.getBoundingClientRect();
      const r = host.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1; })
      .map(el => el.getAttribute("data-qa-id")) }));
  Q.assert(stranded().length === 0, "the fresh prompt is not stranded", stranded());
  const settle = async () => { await Q.frame(); await Q.frame(); await Q.frame(); };
  const feed = document.querySelector("[data-qa-feed]");
  const how = new URLSearchParams(location.search).get("strand");
  const before = box();
  // From here the HARNESS moves the page on purpose; its own shift is reported separately and the
  // extension's shift is still asserted to be zero for everything before this point.
  Q.relayoutFrom = performance.now();
  if (how === "insert") {
    const banner = document.createElement("div");
    banner.style.cssText = "height:200px";
    feed.insertBefore(banner, feed.firstElementChild);
    await settle();
    Q.assert(box().top - before.top > 100, "the insertion really moved the item", { before: before.top, after: box().top });
  } else if (how === "resize") {
    feed.style.maxWidth = "320px";
    window.dispatchEvent(new Event("resize"));
    await settle();
    Q.assert(before.width - box().width > 100, "the resize really changed the item's box", { before: before.width, after: box().width });
  } else {
    item.remove();
    await settle();
    Q.assert(!item.isConnected, "the item really left the page");
    Q.assert(!document.querySelector('[data-jev-key="' + key + '"]'), "the detached item's prompt is gone",
      prompts().map(h => h.getAttribute("data-jev-key")));
  }
  Q.assert(stranded().length === 0, "no prompt is stranded by a " + how, stranded());
  // Whatever survived must still be answerable only for what it is actually sitting on.
  for (const host of prompts()) {
    const live = Q.items().find(el => __JEV_QA_SRC__.keyOf(el, __JEV_QA_SITE__) === host.getAttribute("data-jev-key"));
    Q.assert(!!live, "a surviving prompt still names an item on the page", host.getAttribute("data-jev-key"));
  }
  return { ...await Q.report(), stranded: { how, key, prompts: prompts().length } };`;

// The same stored answer, as a fresh page load finds it: no request for that key, no treatment, no prompt.
const overrideReload = String.raw`
  await Q.ready(); await Q.storage(); await Q.frame();
  const key = new URLSearchParams(location.search).get("overriddenKey");
  const mine = Q.items().filter(el => __JEV_QA_SRC__.keyOf(el, __JEV_QA_SITE__) === key);
  Q.assert(mine.length >= 2, "the stored answer covers more than one item on this page", mine.length);
  Q.assert(mine.every(el => !Q.action(el) && !el.hasAttribute("data-jev-held")),
    "a stored keep answer leaves every item of its key untouched", mine.map(el => Q.action(el)));
  Q.assert(!document.querySelector("[data-jev-overlay]"), "an answered key is never asked about again");
  // Q.models() cannot be used here: it waits for an answer about EVERY data-qa-model item, and the
  // answered key is exactly the one that must never be asked about. Wait for the rest instead.
  await Q.wait(() => __QA_SHIM__.calls.length > 0 && __QA_SHIM__.inflight === 0, "the provider answers the remaining keys");
  await Q.frame(); await Q.frame();
  Q.assert(__QA_SHIM__.calls.every(c => c.items.every(i => i.key !== key)), "the answered key never reaches the provider",
    __QA_SHIM__.calls.map(c => c.items.map(i => i.key)));
  Q.assert(mine.every(el => !Q.action(el)), "the stored answer still wins once the provider has answered", mine.map(el => Q.action(el)));
  Q.assert(!document.querySelector("[data-jev-overlay]"), "no prompt appears for an answered key");
  const deterministic = Q.items().filter(el => ["adAttr","adLabel","suggestedLabel","suggestedFollow"].includes(el.getAttribute("data-qa-kind")));
  Q.assert(deterministic.length > 0 && deterministic.every(el => Q.action(el)), "deterministic verdicts still apply", deterministic.length);
  return { ...await Q.report(), overrideReload: { key, items: mine.length } };`;

const cleanControl = String.raw`
  await Q.ready();
  Q.assert(!window.__JEV_QA__ && !document.getElementById("jev-declutter"), "control has no extension runtime");
  Q.depth("before-scroll");
  for (let i=0; i<30; i++) {
    await Q.step(i >= 20 && __fx.site === "x" ? -400 : 400);
    if ((i+1)%10 === 0) Q.depth("step-" + (i+1));
  }
  const growth = await Q.growth();
  if (location.pathname !== "/messages") {
    __fx.append(["adAttr","organic"], "control-task");
    for (const [channel, invoke] of [
      ["control-raf", () => __fx.rafInsert(["adLabel","organic"], "control-raf")],
      ["control-ro", () => __fx.roInsert(["adAttr","organic"], "control-ro")],
      ["ro-idle", () => scrollBy(0,-1)]
    ]) {
      const old = new Set(Object.keys(__fx.ioFirst));
      await Q.wait(() => Object.entries(__fx.ioFirst).some(([id,e]) => e.channel === channel && !old.has(id)),
        "control " + channel, invoke);
    }
    __fx.append(["unknown","unknown"],"control-cache-shape");
    await Q.frame();
  }
  Q.assert(!document.querySelector("[data-jev]"), "control never marks any element");
  Q.depth("after-growth-and-probes");
  return { ...await Q.report(), growth };`;

function modes(fixture: string): Scenario[] {
  const result: Scenario[] = [{ name: "scroll", code: baseline }];
  if (fixture === "x-messages-en") {
    result.push({ name: "SPA-from-excluded", code: String.raw`
      await Q.ready(); Q.validate(true);
      await Q.wait(() => __JEV_QA__.processed > 0, "SPA starts scanner", () => __fx.goHome());
      await Q.models(); Q.validate(); return Q.report();` });
    return result;
  }
  if (fixture === "stress-x-en") return result;
  result.push(
    { name: "slow-storage", query: "slowStorage=500", code: String.raw`
      await Q.ready();
      const before = Q.items().filter(e => e.getAttribute("data-qa-expect") === "hide");
      Q.assert(before.every(e => e.getAttribute("data-jev") === "hide"), "defaults before delayed storage");
      await Q.storage(); await Q.models(); Q.validate();
      for (const el of before) Q.assert(__fx.ioFirst[el.getAttribute("data-qa-id")]?.height === 0, "slow storage no flash", el.getAttribute("data-qa-id"));
      return Q.report();` },
    { name: "429", query: "fail=429", code: String.raw`
      await Q.ready(); await Q.models(true); Q.validate(false, true); return Q.report();` },
    { name: "fast-settings-module", query: "module=keep", code: String.raw`
      await Q.ready(); await Q.models();
      for (const el of Q.items().filter(e => e.getAttribute("data-qa-kind") === "module")) {
        Q.assert(!Q.action(el), "fast module keep never treated", el.outerHTML);
        Q.assert(!__QA_METRICS__.treatments.some(t => t.id === el.getAttribute("data-qa-id") && (t.value || t.old)),
          "fast module never received a treatment");
        Q.assert(__fx.ioFirst[el.getAttribute("data-qa-id")]?.height > 0, "module visible first frame");
      }
      return Q.report();` },
    { name: "in-viewport-model", query: "holdClassify=1&arrange=model", code: String.raw`
      await Q.ready();
      const el = document.querySelector("[data-qa-model]");
      await Q.frame();
      Q.assert(el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight, "model inside viewport");
      __QA_SHIM__.releaseClassify();
      await Q.models();
      Q.assert(el.getAttribute("data-jev") === "blur", "late in-viewport model blurs never hides", el.outerHTML);
      return Q.report();` }
  );
  // Reconciliation cases on every site, with actual initial targets in and below the viewport.
  for (const [category, action] of [["ad", "keep"], ["module", "keep"], ["module", "blur"]] as const) {
    result.push({ name: `slow-settings-${category}-${action}`,
      query: `slowStorage=500&${category}=${action}&arrange=${category}`,
      code: String.raw`
        await Q.ready();
        const targets = Q.items().filter(e => new URLSearchParams(location.search).get("arrange") === "ad"
          ? ["adAttr","adLabel"].includes(e.getAttribute("data-qa-kind")) : e.getAttribute("data-qa-kind") === "module");
        const first = targets[0], last = targets.at(-1);
        Q.assert(first !== last, "distinct near and far reconciliation targets");
        Q.assert(Q.action(first) === "hide" && Q.action(last) === "hide", "defaults applied before storage");
        await Q.storage();
        await Q.wait(() => Q.target(first).hasAttribute("data-jev-held"), "near item held after reconciliation");
        Q.assert(Q.action(first) === "hide", "near hidden item stays hidden");
        const action = new URLSearchParams(location.search).get(new URLSearchParams(location.search).get("arrange"));
        await Q.wait(() => Q.action(last) === (action === "keep" ? null : action), "below item reconciles");
        return Q.report();` });
  }
  result.push({ name: "slow-disable", query: "slowStorage=500&siteEnabled=false", code: String.raw`
    await Q.ready();
    scrollTo(0,800); await Q.frame();
    const before = [...document.querySelectorAll("[data-jev]")].map(el => [el, el.getAttribute("data-jev")]);
    Q.assert(before.length > 0, "disable has preexisting treatments");
    await Q.storage();
    for (const [el, action] of before) Q.assert(el.getAttribute("data-jev") === action, "disable preserves all treatments");
    const added = __fx.append(["adAttr", "organic"], "disabled-insert");
    await Q.frame(); await Q.frame();
    Q.assert(added.every(el => !el.hasAttribute("data-jev")), "disabled scanner ignores new items");
    return Q.report();` });
  if (fixture.startsWith("youtube")) result.push({ name: "late-module", code: String.raw`
    await Q.ready(); await Q.models();
    scrollTo(0,0); await Q.frame();
    const top = document.querySelector('[data-qa-id="late-top"]'), bottom = document.querySelector('[data-qa-id="late-bottom"]');
    // Adding the site's own child must not resize its placeholder: isolate extension placement from
    // a layout shift caused by the fixture growing its own content.
    for (const el of [top, bottom]) { el.style.height = el.getBoundingClientRect().height + "px"; el.style.minHeight = "0"; }
    Q.assert(top.getBoundingClientRect().top >= 0 && top.getBoundingClientRect().top < innerHeight, "late module starts in viewport");
    await Q.wait(() => top.getAttribute("data-jev") && bottom.getAttribute("data-jev"), "late modules applied",
      () => { __fx.lateModule(top); __fx.lateModule(bottom); });
    await Q.frame();
    Q.assert(top.getAttribute("data-jev") === "blur", "painted late module blurs");
    Q.assert(bottom.getAttribute("data-jev") === "hide", "below late module hides");
    return Q.report();` });
  // todo 29: the user answer prompt. The screenshot run leaves the prompt up, on the Korean
  // fixture, so the evidence shows the ko wording; the answer runs assert both decisions.
  if (fixture === "x-ko") result.push({ name: "overlay-prompt", query: "holdClassify=1&arrange=model", code: overlayPrompt, screenshot: "overlay" });
  if (fixture === "x-en") result.push(
    { name: "overlay-no", query: "holdClassify=1&arrange=model&answer=no", code: overlayPrompt },
    { name: "overlay-yes", query: "holdClassify=1&arrange=model&answer=yes", code: overlayPrompt }
  );
  // A flow-layout fixture, where inserting or narrowing really moves the prompted item.
  if (fixture === "linkedin-en") {
    for (const how of ["insert", "resize", "detach"]) {
      result.push({ name: `overlay-stranded-${how}`, query: `holdClassify=1&arrange=model&strand=${how}`, code: overlayStranded });
    }
  }
  if (fixture.startsWith("x-")) result.push({ name: "recycled-hidden", code: String.raw`
    await Q.ready(); await Q.models();
    const ads = Q.items().filter(el => el.getAttribute("data-jev") === "hide" && el.getAttribute("data-qa-kind") === "adAttr");
    const above = ads[0], below = ads.at(-1);
    Q.assert(above !== below, "distinct recycled cells");
    await Q.wait(() => above.hasAttribute("data-jev-held"), "above recycled cell held", () => __fx.recycle(above,"organic","held-probe"));
    Q.assert(above.getAttribute("data-jev") === "hide", "above recycled organic stays hidden");
    await Q.wait(() => !below.hasAttribute("data-jev"), "below recycled cell revealed", () => __fx.recycle(below,"organic","reveal-probe"));
    Q.assert(below.getAttribute("data-qa-kind") === "organic", "same node recycled organic");
    await Q.frame(); return Q.report();` });
  return result;
}

function controlModes(fixture: string): Scenario[] {
  const controls: Scenario[] = [{ name: "extension-free-scroll", query: "clean=1", code: cleanControl }];
  if (fixture !== "stress-x-en" && fixture !== "x-messages-en") {
    for (const category of ["ad", "module"]) controls.push({
      name: `extension-free-arrange-${category}`, query: `clean=1&slowStorage=500&${category}=keep&arrange=${category}`,
      code: String.raw`await Q.ready(); await Q.frame(); await Q.frame();
        Q.assert(!window.__JEV_QA__ && !document.querySelector("[data-jev]"), "control has no scanner");
        return Q.report();`
    });
  }
  return controls;
}

const helperBuild = await Bun.build({
  entrypoints: ["qa-helpers"], target: "browser", format: "iife",
  plugins: [{
    name: "qa-helpers",
    setup(builder) {
      builder.onResolve({ filter: /^qa-helpers$/ }, () => ({ path: "qa-helpers", namespace: "qa" }));
      builder.onLoad({ filter: /.*/, namespace: "qa" }, () => ({
        loader: "ts",
        contents: `
          import { SITES } from ${JSON.stringify(root + "/src/sites.ts")};
          import { extractSignals, toDescriptor } from ${JSON.stringify(root + "/src/signals.ts")};
          import { DEFAULT_SETTINGS, sigKey } from ${JSON.stringify(root + "/src/storage.ts")};
          import { MIN_MODEL_GROUP, MODEL_GROUP_SHARE, modelGroupCap, providerKey } from ${JSON.stringify(root + "/src/cache.ts")};
          import { today } from ${JSON.stringify(root + "/src/decide.ts")};
          import { overrideKey } from ${JSON.stringify(root + "/src/overrides.ts")};
          globalThis.__JEV_QA_SRC__ = { DEFAULT_SETTINGS, sigKey, providerKey, today, overrideKey, MIN_MODEL_GROUP, MODEL_GROUP_SHARE, modelGroupCap,
            modules: SITES[globalThis.__JEV_QA_SITE__].modules.map(m => m.selector).join(","),
            descriptorOf: (el, site) => toDescriptor(0, el, SITES[site], extractSignals(el, SITES[site])),
            keyOf: (el, site) => toDescriptor(0, el, SITES[site], extractSignals(el, SITES[site])).key };
        `
      }));
    }
  }]
});
if (!helperBuild.success || !helperBuild.outputs[0]) throw new Error("QA helper bundle failed: " + helperBuild.logs.join("\n"));
const shim = await helperBuild.outputs[0].text() + "\n" + await Bun.file(root + "/scripts/qa/chrome-shim.js").text() + "\n" + drivers;
const content = await Bun.file(root + "/dist/content.js").text();
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__qa/chrome-shim.js") return new Response(shim, { headers: { "Content-Type": "text/javascript" } });
    if (url.pathname === "/__qa/content.js") return new Response(content, { headers: { "Content-Type": "text/javascript" } });
    const fixture = url.pathname === "/messages" ? "x-messages-en" : url.pathname.slice(1);
    if (!fixtures.some(name => name === fixture)) return new Response("Not found", { status: 404 });
    const site = fixture.startsWith("stress") ? "x" : fixture.split("-")[0];
    let html = await Bun.file(`${root}/tests/fixtures/${fixture}.html`).text();
    // The fixture toggles its QA-only RO trigger between 1px and 2px. Keep that probe out
    // of normal flow so an anchor delta measures the extension, not its own test apparatus.
    html = html.replace('id="fx-probe" style="height:1px"', 'id="fx-probe" style="position:absolute;width:1px;height:1px"');
    // Only fixture markup is rearranged; extension code and fixture scripts remain intact.
    // Put a deterministic target near the top, and its distinct clone at the bottom, before parsing.
    const arrange = url.searchParams.get("arrange");
    if (arrange) {
      const tagPattern = /<([\w-]+)\b[^>]*data-qa-kind="([^"]+)"[^>]*>/g;
      let match: RegExpExecArray | null;
      while ((match = tagPattern.exec(html))) {
        const wanted = arrange === "module" ? match[2] === "module" :
          arrange === "model" ? match[2] === "unknown" : ["adAttr", "adLabel"].includes(match[2] ?? "");
        if (!wanted) continue;
        const start = match.index, tag = match[1];
        // Fixture roots may contain the same tag (div/article); balance their opening and closing tokens.
        const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "g");
        tokens.lastIndex = start;
        let depth = 0, end = start, token: RegExpExecArray | null;
        while ((token = tokens.exec(html))) {
          depth += token[0].startsWith("</") ? -1 : 1;
          if (depth === 0) { end = tokens.lastIndex; break; }
        }
        const node = html.slice(start, end);
        const remaining = html.slice(0, start) + html.slice(end);
        // Insert at the start of the actual feed, after its one-pixel RO probe.
        const probeEnd = remaining.indexOf("</div>", remaining.indexOf('id="fx-probe"')) + 6;
        html = remaining.slice(0, probeEnd) + node + remaining.slice(probeEnd);
        const copy = node.replace(/data-qa-id="[^"]+"/, 'data-qa-id="reconcile-far"');
        const script = html.indexOf('<script id="fx-infinite-scroll">');
        const mainEnd = html.lastIndexOf("</main>", script);
        const feedEnd = html.lastIndexOf("</div>", mainEnd);
        html = html.slice(0, feedEnd) + copy + html.slice(feedEnd);
        break;
      }
    }
    html = html.replace(/<head>/i, `<head><script>globalThis.__JEV_QA_ENABLE__=${url.searchParams.has("clean") ? "false" : "true"};globalThis.__JEV_QA_SITE__=${JSON.stringify(site)};</script><script src="/__qa/chrome-shim.js"></script>${url.searchParams.has("clean") ? "" : '<script src="/__qa/content.js"></script>'}`);
    return new Response(html, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
    } });
  }
});

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 20_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

let failed = false;
let executed = 0;
const warningCounts = new Map<string, number>();
const warningResults: { fixture: string; mode: string; assertions: BrowserReport["warningAssertions"] }[] = [];
try {
  await mkdir(evidence, { recursive: true });
  for (const fixture of fixtures) {
    if (process.env.JEV_QA_FIXTURE && process.env.JEV_QA_FIXTURE !== fixture) continue;
    const reports: ScenarioReport[] = [];
    const scenarios: Scenario[] = postPaintHideControl ? [{
      name: "post-paint-hide-control", code: String.raw`
        await Q.ready(); await Q.models(); await Q.painted();
        scrollTo(0,0); await Q.frame();
        const victim = Q.items().find(el => {
          const r = el.getBoundingClientRect();
          return el.getAttribute("data-qa-expect") === "keep" && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
        });
        if (!victim) throw new Error("Post-paint control requires a visible keep item");
        document.documentElement.style.overflowAnchor = "none";
        const firstPaint = performance.getEntriesByType("paint").find(e => e.name === "first-paint").startTime;
        const hideAt = performance.now();
        Q.assert(hideAt > firstPaint, "control hide is after first paint", { hideAt, firstPaint });
        victim.style.display = "none";
        await Q.frame(); await Q.frame();
        const report = await Q.report();
        const countedEntries = report.layoutEntries.filter(e => !e.hadRecentInput && !e.excludedPrePaint && e.at >= hideAt);
        return { ...report, postPaintHide: { id:victim.getAttribute("data-qa-id"), firstPaint, hideAt,
          countedEntries, countedShift:countedEntries.reduce((sum,e) => sum+e.value, 0) } };`
    }, { name:"extension-free-scroll", query:"clean=1", code:cleanControl }]
    : idleOscillationControl ? [{
      name: "idle-oscillation-control", code: String.raw`
        await Q.ready(); await Q.models();
        // Scratch copy only: a real site-side RO feedback loop, outside the viewport.
        const target = document.createElement("div");
        target.style.cssText = "position:fixed;left:-100px;top:-100px;width:1px;height:1px";
        let deliveries = 0;
        const observer = new ResizeObserver(() => {
          deliveries++;
          target.style.height = deliveries % 2 ? "2px" : "1px";
          dispatchEvent(new Event("qa-progress"));
        });
        try {
          await Q.wait(() => deliveries > 0, "scratch RO first delivery", () => {
            document.body.append(target); observer.observe(target);
          });
          const report = await Q.report();
          return { ...report, scratchOscillationDeliveries:deliveries };
        } finally {
          observer.disconnect(); target.remove();
        }`
    }, { name: "extension-free-scroll", query:"clean=1", code:cleanControl }]
    : warningCheck ? [{ name:"scroll", code:baseline }, { name:"extension-free-scroll", query:"clean=1", code:cleanControl }]
    : forcedHide ? [{ name: "forced-hide-control", code: String.raw`
      await Q.ready(); await Q.models();
      scrollTo(0,0); await Q.frame();
      const victim = Q.items().find(e => e.getAttribute("data-qa-expect") === "keep" && e.getBoundingClientRect().height > 0);
      // Disable scroll anchoring only in the deliberate negative control, so it cannot mask the hide.
      document.documentElement.style.overflowAnchor = "none";
      const anchor = Q.items().find(e => e !== victim && e.getBoundingClientRect().top > 0 && e.getBoundingClientRect().top < innerHeight);
      const before = anchor?.getBoundingClientRect().top;
      // The harness's own deliberate write, flagged so the apply-write attribution assertion does
      // not report this control's injected hide as unwrapped scanner work.
      __QA_METRICS__.harnessWrite = true;
      victim.setAttribute("data-jev", "hide");
      __QA_METRICS__.harnessWrite = false;
      await Q.frame(); await Q.frame();
      const pixels = anchor ? Math.abs(anchor.getBoundingClientRect().top - before) : 0;
      Q.assert(pixels <= .5, "forced-hide anchor shift <= 0.5px", pixels);
      return { ...await Q.report(), forcedHidePixels: pixels };` }] : collisionControl ? [{
        name: "fixture-collision-control", code: String.raw`
          await Q.ready();
          document.querySelector('[data-qa-model] > span[role="note"]').remove();
          Q.preflight("deliberately-ambiguous-fixture");
          throw new Error("Fixture collision preflight failed to reject ambiguous ground truth");`
      }] : [...modes(fixture), ...controlModes(fixture)];
    for (const scenario of scenarios) {
      if (process.env.JEV_QA_MODE && process.env.JEV_QA_MODE !== scenario.name) continue;
      executed++;
      const view = new Bun.WebView({ backend: "chrome", width: 1000, height: 800 });
      try {
        await bounded(view.navigate("about:blank"), "initialize CDP session");
        await bounded(view.cdp("Page.addScriptToEvaluateOnNewDocument", { source: beforeNavigation }), "install error hooks");
        const path = scenario.path ?? (fixture === "x-messages-en" ? "/messages" : `/${fixture}`);
        await bounded(view.navigate(`${server.url.origin}${path}?${scenario.query ?? ""}`), "navigation");
        const preflight = await bounded(view.evaluate<{ chrome: boolean; layoutShift: boolean }>(
          `({ chrome: navigator.userAgent.includes("Chrome"), layoutShift: PerformanceObserver.supportedEntryTypes.includes("layout-shift") })`), "preflight");
        if (!preflight.chrome || !preflight.layoutShift) {
          throw new Error("QA requires Chromium with layout-shift support. Install Chrome/Chromium and use backend: 'chrome'.");
        }
        const report = await bounded(view.evaluate<BrowserReport>(`(async () => { ${scenario.code} })()`), `${fixture}/${scenario.name}`);
        reports.push({ name: scenario.name, report });
        if (scenario.screenshot) {
          const shot = await bounded(
            view.cdp<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }),
            "screenshot"
          );
          await Bun.write(resolve(evidence, `${fixture}.${scenario.screenshot}.png`), Buffer.from(shot.data, "base64"));
        }
        // The same stored answer, read back by a fresh page load: persistence across a reload.
        if (scenario.name === "overlay-no" && report.overrideSnapshot && report.overrideKey) {
          scenarios.push({ name: "override-reload", code: overrideReload,
            query: `arrange=model&overriddenKey=${report.overrideKey}` +
              `&seedOverrides=${encodeURIComponent(JSON.stringify(report.overrideSnapshot))}` });
        }
        if (scenario.name === "scroll" && fixture === "stress-x-en" && report.cacheSnapshot && !forcedHide && !collisionControl && !warningCheck) {
          const snapshot = report.cacheSnapshot as CacheSnapshot;
          // The fixture's largest all-keep group is its organic skeleton; poison exactly that key.
          const largest = [...(report.collisionGroups ?? [])]
            .filter((g) => g.keep.length === g.members.length && g.members.length > 1)
            .sort((a, b) => b.members.length - a.members.length)[0];
          if (!largest) throw new Error("stress-x-en reported no all-keep collision group to poison");
          const order = snapshot.order ?? [];
          const poisoned = { ...snapshot,
            entries: { ...snapshot.entries, [largest.key]: { ad: 0.95, suggested: null } },
            order: order.includes(largest.key) ? order : [...order, largest.key] };
          scenarios.push({ name: "poisoned-cache-cap", code: poisonedCacheCap,
            query: `seedCache=${encodeURIComponent(JSON.stringify(poisoned))}&poisonedKey=${largest.key}` });
        }
        if (scenario.name === "scroll" && report.cacheSnapshot && !forcedHide && !collisionControl && !warningCheck) scenarios.push({
          name: "seeded-cache-alias", query: `seedCache=${encodeURIComponent(JSON.stringify(report.cacheSnapshot))}`,
          code: String.raw`
            await Q.ready(); await Q.storage(); await Q.frame();
            Q.assert(__QA_SHIM__.calls.length === 0, "persisted-cache control made no classify request");
            Q.validate();
            const r = await Q.report();
            const cacheAliasProof = r.itemTable.filter(row => row.groundTruth.expect === "keep" && row.latest.action &&
              Math.max(r.cacheSnapshot?.entries[row.descriptor.key]?.ad || 0, r.cacheSnapshot?.entries[row.descriptor.key]?.suggested || 0) >= .5);
            return { ...r, cacheAliasProof };`
        });
        warningCounts.set(scenario.name, (warningCounts.get(scenario.name) ?? 0) + report.warnings.length);
        if (report.failures.length) failed = true;
        const longTasks = report.longTaskDiagnostics;
        console.log(`${fixture}/${scenario.name}: ${report.failures.length ? "FAIL" : "PASS"} shift=${report.shift} failures=${report.failures.length} longtasks=${longTasks ? `${longTasks.attributed.length}attributed/${longTasks.unattributed.length}diagnostic` : "unknown"} ${JSON.stringify(report.failures.slice(0, 3))}`);
      } catch (error) {
        // no-excuse-ok: catch -- each isolated browser scenario must leave a failed report and close its view.
        failed = true;
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        const report = await bounded(view.evaluate<BrowserReport>("Q.report()"), "failure diagnostics")
          .catch((diagnosticError: unknown) => {
            console.error("Failure diagnostics unavailable:", diagnosticError);
            return undefined;
          });
        reports.push({ name: scenario.name, error: message, ...(report ? { report } : {}) });
        console.error(`${fixture}/${scenario.name}: FAIL ${message}`);
      } finally {
        view.close();
      }
    }
    // The extension-free control is a property of the SUITE, not of each scenario. A fixture or
    // mode filter can exclude it from this run; that is "not executed", not a failure (F2
    // follow-up). A control that RAN and errored is "errored" even when the scenario catch
    // managed to attach diagnostics to it, and it keeps failing the run: its own catch already
    // set failed, and every other scenario gets the synthetic control failure below.
    const control = reports.find(s => s.name === "extension-free-scroll");
    const cleanWarnings = control?.report?.warningAssertions.count;
    const controlStatus: ControlStatus = !control ? "not-executed"
      : control.error !== undefined || !control.report ? "errored"
      : cleanWarnings === 0 ? "zero" : "nonzero";
    for (let i = 0; i < reports.length; i++) {
      const scenario = reports[i];
      if (!scenario?.report) continue;
      const report = scenario.report;
      const controlZero = scenario.name.startsWith("extension-free")
        ? scenario.error === undefined && report.warningAssertions.count === 0
        : controlStatus === "not-executed" ? null : controlStatus === "zero";
      const assertions = { ...report.warningAssertions, controlZero, controlStatus,
        ...(cleanWarnings === undefined ? {} : { controlWarnings:cleanWarnings }) };
      warningResults.push({ fixture, mode:scenario.name, assertions });
      const controlPassed = controlZero === true || controlZero === null;
      const failures = !controlPassed && !forcedHide && !collisionControl
        ? [...report.failures, { label:"extension-free control has zero RO warnings", actual:cleanWarnings ?? "missing control" }]
        : report.failures;
      reports[i] = { ...scenario, report:{ ...report, failures, warningAssertions:assertions } };
      if (failures.length) failed = true;
      const verdict = !(assertions.boundPassed && assertions.idlePassed && controlPassed) ? "FAIL"
        : controlZero === null ? "PASS_CONTROL_NOT_EXECUTED" : "PASS";
      console.log(`${fixture}/${scenario.name}: WARNINGS_${verdict} ${JSON.stringify(assertions)}`);
    }
    const output = postPaintHideControl ? `${fixture}.post-paint-hide.json` : idleOscillationControl ? `${fixture}.idle-oscillation.json` : forcedHide ? `${fixture}.forced-hide.json` : collisionControl ? `${fixture}.collision-control.json` : `${fixture}.json`;
    await Bun.write(resolve(evidence, output), JSON.stringify({ fixture, forcedHide, reports }, null, 2) + "\n");
    await Bun.write(resolve(evidence, output.replace(".json", ".summary.json")), JSON.stringify({
      fixture, reports: reports.map(s => ({ name:s.name, error:s.error, failures:s.report?.failures,
        shift:s.report?.shift, firstPaint:s.report?.firstPaint, excludedPrePaint:s.report?.excludedPrePaint,
        warnings:s.report?.warnings.length, warningAssertions:s.report?.warningAssertions,
        longTaskDiagnostics:s.report?.longTaskDiagnostics, adjudication:s.report?.adjudication }))
    }, null, 2) + "\n");
    // One fixture is sufficient for the deliberate control; normal execution always covers all ten.
    if (forcedHide || collisionControl || idleOscillationControl || postPaintHideControl) break;
  }
} finally {
  server.stop(true);
  Bun.WebView.closeAll();
}
const warningExitCode = warningResults.length > 0 && warningResults.length === executed && warningResults.every(r =>
  r.assertions.boundPassed && r.assertions.idlePassed &&
  (r.assertions.controlZero === true || r.assertions.controlZero === null)) ? 0 : 1;
if (executed === 0) {
  failed = true;
  console.error("FAIL: no browser scenarios executed; check JEV_QA_FIXTURE and JEV_QA_MODE.");
}
await Bun.write(resolve(evidence, postPaintHideControl ? "post-paint-hide-summary.json" : idleOscillationControl ? "idle-oscillation-summary.json" : forcedHide ? "forced-hide-summary.json" : collisionControl ? "collision-control-summary.json" : "run-summary.json"),
  JSON.stringify({ exitCode: failed ? 1 : 0, warningExitCode, warningResults, executed, warningCounts: Object.fromEntries(warningCounts),
    fixtureFilter: process.env.JEV_QA_FIXTURE ?? null, modeFilter: process.env.JEV_QA_MODE ?? null,
    cleanup: { viewsClosed: true, serverStopped: true, tempDirectoriesCreated: 0 } }, null, 2) + "\n");
console.log(`RO_WARNING_COUNTS=${JSON.stringify(Object.fromEntries(warningCounts))}`);
console.log(`WARNING_EXIT_CODE=${warningExitCode}`);
console.log(`QA_EXIT_CODE=${failed ? 1 : 0}`);
process.exitCode = failed ? 1 : 0;
