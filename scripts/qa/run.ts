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
  "instagram-ko", "linkedin-en", "linkedin-ko", "linkedin-react-en", "linkedin-react-ko",
  "stress-x-en", "x-messages-en"
] as const;

// Installed by CDP before navigation, including errors from either of the first scripts.
// Never return true from window.onerror or cancel the error event.
const beforeNavigation = String.raw`(() => {
  const m = window.__QA_METRICS__ = { errors: [], shifts: [], longtasks: [], first: {}, anchors: [], treatments: [], frame: 0 };
  requestAnimationFrame(function frame() { m.frame++; requestAnimationFrame(frame); });
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
      super((entries, observer) => {
        callback(entries, observer);
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
    const shift = m.shifts.filter(e => !e.recent && (firstPaint === undefined || e.at >= firstPaint))
      .reduce((sum,e) => sum+e.value, 0);
    Q.assert(errors.length === 0, "no page errors or unhandled rejections", errors);
    Q.assert(shift === 0, "layout-shift total is zero", m.shifts);
    const runLongtasks = m.longtasks.filter(e => e.at >= Q.runStart);
    Q.assert(runLongtasks.every(e => e.duration <= 50), "no long task > 50ms during run", runLongtasks);
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
      shift, maxAnchorShift: Math.max(0,...m.anchors.map(e => e.shift)), p95, maxCallback: max,
      warnings, warningAssertions, errors, runStart: Q.runStart, longtasks: m.longtasks, runLongtasks, anchors: m.anchors,
      paint, firstPaint:firstPaint ?? null, excludedPrePaint, layoutEntries, collisionGroups, itemTable,
      warningDepth: Q.warningDepth, preflights: Q.preflights, adjudication,
      cacheSnapshot: __QA_SHIM__.snapshot()[__JEV_QA_SRC__.sigKey(__JEV_QA_SITE__)] ?? null,
      treatments: treatmentWrites, scrollUpCases: Q.scrollUpCases, firstFrames: __fx.ioFirst, applyPaths: m.first,
      calls: __QA_SHIM__.calls, answers: __QA_SHIM__.answers };
  };
})();`;

type BrowserReport = {
  readonly failures: readonly unknown[];
  readonly shift: number;
  readonly firstPaint: number | null;
  readonly excludedPrePaint: { readonly count: number; readonly sum: number };
  readonly warnings: readonly string[];
  readonly cacheSnapshot?: unknown;
  readonly adjudication?: unknown;
  readonly warningAssertions: {
    readonly count: number;
    readonly roTreatmentWrites: number;
    readonly idleCounts: readonly number[];
    readonly boundPassed: boolean;
    readonly idlePassed: boolean;
    readonly controlZero?: boolean;
    readonly controlWarnings?: number;
  };
};
type Scenario = { readonly name: string; readonly query?: string; readonly path?: string; readonly code: string };
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
          import { providerKey } from ${JSON.stringify(root + "/src/cache.ts")};
          import { today } from ${JSON.stringify(root + "/src/decide.ts")};
          globalThis.__JEV_QA_SRC__ = { DEFAULT_SETTINGS, sigKey, providerKey, today,
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
      victim.setAttribute("data-jev", "hide");
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
        console.log(`${fixture}/${scenario.name}: ${report.failures.length ? "FAIL" : "PASS"} shift=${report.shift} failures=${report.failures.length} ${JSON.stringify(report.failures.slice(0, 3))}`);
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
    const cleanWarnings = reports.find(s => s.name === "extension-free-scroll")?.report?.warningAssertions.count;
    for (let i = 0; i < reports.length; i++) {
      const scenario = reports[i];
      if (!scenario?.report) continue;
      const report = scenario.report;
      const controlZero = scenario.name.startsWith("extension-free") ? report.warningAssertions.count === 0 : cleanWarnings === 0;
      const assertions = { ...report.warningAssertions, controlZero,
        ...(cleanWarnings === undefined ? {} : { controlWarnings:cleanWarnings }) };
      warningResults.push({ fixture, mode:scenario.name, assertions });
      const failures = !controlZero && !forcedHide && !collisionControl
        ? [...report.failures, { label:"extension-free control has zero RO warnings", actual:cleanWarnings ?? "missing control" }]
        : report.failures;
      reports[i] = { ...scenario, report:{ ...report, failures, warningAssertions:assertions } };
      if (failures.length) failed = true;
      console.log(`${fixture}/${scenario.name}: WARNINGS_${assertions.boundPassed && assertions.idlePassed && controlZero ? "PASS" : "FAIL"} ${JSON.stringify(assertions)}`);
    }
    const output = postPaintHideControl ? `${fixture}.post-paint-hide.json` : idleOscillationControl ? `${fixture}.idle-oscillation.json` : forcedHide ? `${fixture}.forced-hide.json` : collisionControl ? `${fixture}.collision-control.json` : `${fixture}.json`;
    await Bun.write(resolve(evidence, output), JSON.stringify({ fixture, forcedHide, reports }, null, 2) + "\n");
    await Bun.write(resolve(evidence, output.replace(".json", ".summary.json")), JSON.stringify({
      fixture, reports: reports.map(s => ({ name:s.name, error:s.error, failures:s.report?.failures,
        shift:s.report?.shift, firstPaint:s.report?.firstPaint, excludedPrePaint:s.report?.excludedPrePaint,
        warnings:s.report?.warnings.length, warningAssertions:s.report?.warningAssertions,
        adjudication:s.report?.adjudication }))
    }, null, 2) + "\n");
    // One fixture is sufficient for the deliberate control; normal execution always covers all ten.
    if (forcedHide || collisionControl || idleOscillationControl || postPaintHideControl) break;
  }
} finally {
  server.stop(true);
  Bun.WebView.closeAll();
}
const warningExitCode = warningResults.length > 0 && warningResults.length === executed && warningResults.every(r =>
  r.assertions.boundPassed && r.assertions.idlePassed && r.assertions.controlZero) ? 0 : 1;
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
