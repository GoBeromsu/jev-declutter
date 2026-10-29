import { ensureCurrent, freshCache, loadSigCache, lookup, MAX_ITEMS, providerKey, remember } from "./cache";
import { actionFor, combine, ITEM_CSS, placement, today } from "./decide";
import { deterministic } from "./rules";
import { extractSignals, toDescriptor } from "./signals";
import type { SiteConfig } from "./sites";
import { DEFAULT_SETTINGS, loadSettings } from "./storage";
import type { Action, ClassifyResult, ItemDescriptor, Message, Settings, SignatureCache } from "./types";

export interface Mutation {
  readonly target: Node;
  readonly addedNodes: Iterable<Node>;
}

interface Observer {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

/** Browser scheduling and storage boundaries; tests drive delivery, never elapsed sleeps. */
export interface ScanHost {
  settings(): Promise<Settings>;
  cache(): Promise<SignatureCache | undefined>;
  send(message: Message): Promise<ClassifyResult>;
  painted(): boolean;
  now(): number;
  mutations(callback: (records: readonly Mutation[]) => void): () => void;
  resize(callback: () => void): Observer;
  intersection(callback: (near: Element[]) => void): Observer;
  frame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  postTask(callback: () => void): void;
  timer(callback: () => Promise<void>): number;
  cancelTimer(id: number): void;
}

function browserHost(cfg: SiteConfig): ScanHost {
  return {
    settings: loadSettings, cache: () => loadSigCache(cfg.id),
    send: (message) => chrome.runtime.sendMessage<Message, ClassifyResult>(message),
    painted: () => performance.getEntriesByType("paint").length > 0,
    now: () => performance.now(),
    mutations: (callback) => {
      const mo = new MutationObserver(callback);
      mo.observe(document, { childList: true, subtree: true });
      return () => mo.disconnect();
    },
    resize: (callback) => new ResizeObserver(callback),
    intersection: (callback) => new IntersectionObserver((entries) => {
      callback(entries.filter((e) => e.isIntersecting).map((e) => e.target));
    }, { rootMargin: "0px 0px 1500px 0px" }),
    frame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    postTask: (callback) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close(); channel.port2.close(); callback();
      };
      channel.port2.postMessage(null);
    },
    timer: (callback) => window.setTimeout(() => { void callback(); }, 120),
    cancelTimer: (id) => window.clearTimeout(id)
  };
}

interface ItemState {
  readonly key: string;
  readonly descriptor?: ItemDescriptor;
  want: Action | undefined;
}

export function startScanner(cfg: SiteConfig, host: ScanHost = browserHost(cfg)) {
  let settings = DEFAULT_SETTINGS;
  let nextSettings: Settings | undefined;
  let cache = freshCache(today(), providerKey(settings));
  let cacheReady = false;
  let stopped = false;
  let path = location.pathname;
  let inUpdate = false;
  let contentFramePainted = false;
  const pageHasPainted = () => contentFramePainted || host.painted();
  let frameId: number | undefined;
  let timerId: number | undefined;
  let pauseUntil = 0;
  let generation = 0;
  let n = 0;
  let processed = new WeakMap<Element, string>();
  const states = new Map<Element, ItemState>();
  const pending = new Set<Element>();
  const queue = new Map<string, ItemDescriptor>();
  const inflight = new Set<string>();
  const answers = new Map<string, { ad: number | null; suggested: number | null }>();
  const priority = new Set<Element>();
  const modules = cfg.modules.map((m) => m.selector).join(",");
  const selector = [cfg.item, modules].filter(Boolean).join(",");
  const qa = { callbackDurations: [] as number[], processed: 0, applyPaths: new WeakMap<Element, "ro" | "mutation">() };
  const excluded = () => cfg.excludedPaths.some((re) => re.test(location.pathname));
  const active = () => !stopped && !excluded() && settings.sites[cfg.id].enabled;
  const scoreAction = (s: { ad: number | null; suggested: number | null }) =>
    combine(actionFor("ad", s.ad, settings.actions), actionFor("suggested", s.suggested, settings.actions));

  function observe(el: Element) {
    pending.add(el);
    applyRO.unobserve(el);
    applyRO.observe(el);
  }

  function collect(root: Element, candidates: Set<Element>) {
    if (root.matches(selector)) candidates.add(root);
    const parent = root.parentElement?.closest(selector);
    if (parent) candidates.add(parent);
    const module = modules ? root.parentElement?.closest(modules) : null;
    if (module) candidates.add(module);
    for (const el of root.querySelectorAll(selector)) candidates.add(el);
  }

  function initial() {
    if (active()) for (const el of document.querySelectorAll(selector)) {
      if (!processed.has(el)) observe(el);
    }
  }

  function navigation() {
    if (path === location.pathname) return;
    path = location.pathname;
    generation++;
    queue.clear(); inflight.clear(); answers.clear(); pending.clear(); applyRO.disconnect(); nearIO.disconnect();
    processed = new WeakMap();
    states.clear();
    if (!excluded()) for (const el of document.querySelectorAll("[data-jev-held]")) el.removeAttribute("data-jev-held");
    if (nextSettings) { settings = nextSettings; nextSettings = undefined; }
    cache = ensureCurrent(cache, today(), providerKey(settings));
    initial();
  }

  function schedule() {
    if (timerId !== undefined || queue.size === 0 || host.now() < pauseUntil || !active()) return;
    timerId = host.timer(send);
  }

  async function send() {
    timerId = undefined;
    if (!active() || host.now() < pauseUntil) return;
    for (const [el] of states) {
      if (!el.isConnected) { states.delete(el); nearIO.unobserve(el); priority.delete(el); }
    }
    const liveKeys = new Set([...states.values()].map((state) => state.key));
    for (const key of queue.keys()) if (!liveKeys.has(key)) queue.delete(key);
    const nearKeys = new Set([...priority].map((el) => states.get(el)?.key));
    // Share the background cap: excess items receive null scores there, silently under-filtering the feed.
    const batch = [...queue.values()].sort((a, b) => Number(nearKeys.has(b.key)) - Number(nearKeys.has(a.key))).slice(0, MAX_ITEMS);
    if (batch.length === 0) return;
    for (const d of batch) { queue.delete(d.key); inflight.add(d.key); }
    const sentGeneration = generation;
    // Runtime transport is an external boundary: worker loss is an ordinary fail-open result.
    const result = await host.send({ type: "classify", site: cfg.id, items: batch })
      .catch((): ClassifyResult => ({ ok: false, error: "transport" }));
    if (stopped || generation !== sentGeneration) return;
    for (const d of batch) inflight.delete(d.key);
    if (!result.ok) {
      if (result.error === "http-429" || result.error === "budget") pauseUntil = host.now() + 60_000;
      for (const d of batch) answers.set(d.key, { ad: null, suggested: null });
      schedule();
      return;
    }
    batch.forEach((d, i) => answers.set(d.key, result.scores[i] ?? { ad: null, suggested: null }));
    for (const [el, state] of states) {
      const score = answers.get(state.key);
      if (score && el.isConnected) observe(el);
    }
    schedule();
  }

  /** A hidden element's own rect is zero: use a rendered predecessor, then its parent. */
  function revealTop(el: Element): number {
    let previous = el.previousElementSibling;
    while (previous) {
      if (previous.getAttribute("data-jev") !== "hide") {
        const rect = previous.getBoundingClientRect();
        if (rect.height > 0 || rect.width > 0) return rect.bottom;
      }
      previous = previous.previousElementSibling;
    }
    return el.parentElement?.getBoundingClientRect().top ?? 0;
  }

  function flush(applyPath: "ro" | "mutation") {
    if (!active()) return;
    cache = ensureCurrent(cache, today(), providerKey(settings));
    const writes: { el: Element; want: Action; top: number; reveal: boolean }[] = [];
    const painted = pageHasPainted();
    for (const el of pending) {
      applyRO.unobserve(el);
      if (!el.isConnected) { pending.delete(el); states.delete(el); nearIO.unobserve(el); priority.delete(el); continue; }
      const isModule = modules !== "" && el.matches(modules);
      let state = states.get(el);
      let key: string;
      let descriptor: ItemDescriptor | undefined;
      let want: Action | undefined;
      if (isModule) {
        key = "module"; want = settings.actions.module;
      } else {
        const signals = extractSignals(el, cfg);
        descriptor = toDescriptor(n++, el, cfg, signals);
        key = descriptor.key;
        const local = deterministic(signals, cfg);
        if (local) want = actionFor(local.category, local.p, settings.actions);
        else if (!cacheReady) continue;
        else {
          const scores = lookup(cache, key) ?? answers.get(key);
          if (scores) want = scoreAction(scores);
          else if (signals.chromeText.length === 0 && !signals.followButton && !signals.hasExternalLink && signals.media === "none") want = "keep";
        }
      }
      const recycled = state !== undefined && state.key !== key;
      if (processed.get(el) === key && !recycled && state?.want === want) { pending.delete(el); continue; }
      if (!state || recycled) {
        state = { key, descriptor, want }; states.set(el, state); qa.processed++;
      } else state.want = want;
      processed.set(el, key);
      pending.delete(el);
      nearIO.observe(el);
      if (want === undefined && descriptor) {
        if (!inflight.has(key) && !answers.has(key)) queue.set(key, descriptor);
      }
      const desired = want ?? "keep";
      const reveal = el.getAttribute("data-jev") === "hide" && (recycled || desired !== "hide");
      writes.push({ el, want: desired, reveal, top: reveal && painted ? revealTop(el) : el.getBoundingClientRect().top });
    }
    // Complete every geometry read before the first attribute write.
    for (const { el, want, top, reveal } of writes) {
      if (el.hasAttribute("data-jev-held") || (reveal && painted && top < innerHeight)) {
        el.setAttribute("data-jev-held", ""); continue;
      }
      // Placement may blur a visible item, never reveal one already collapsed.
      let action = el.getAttribute("data-jev") === "hide" && want === "hide"
        ? "hide"
        : placement(want, { pageHasPainted: painted, top, viewportHeight: innerHeight });
      if (el.getAttribute("data-jev") === "blur" && action === "hide") action = "blur";
      if (action === "keep") el.removeAttribute("data-jev");
      else el.setAttribute("data-jev", action);
      qa.applyPaths.set(el, applyPath);
    }
    schedule();
  }

  const applyRO = host.resize(() => flush("ro"));
  const nearIO = host.intersection((elements) => { for (const el of elements) priority.add(el); });
  const disconnectMO = host.mutations((records) => {
    const started = host.now();
    navigation();
    if (!active()) return;
    const added = new Set<Element>();
    const touched = new Set<Element>();
    const candidates = new Set<Element>();
    let firstAdded: Element | undefined;
    const insideAdded = (node: Element | null): boolean => {
      if (node && firstAdded?.contains(node)) return true;
      for (let cur = node; cur; cur = cur.parentElement) if (added.has(cur)) return true;
      return false;
    };
    // At document_start the new body covers every feed item. One document
    // traversal replaces enumerating thousands of its parser child records.
    const body = document.body;
    const bodyInserted = body !== null && records.some(record =>
      record.target === document.documentElement && [...record.addedNodes].includes(body)
    );
    if (bodyInserted) collect(document.documentElement, candidates);
    else for (const record of records) {
      if (record.target instanceof Element) {
        // A newly inserted parent already covers its parser descendant records.
        if (insideAdded(record.target)) continue;
        touched.add(record.target);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          added.add(node);
          firstAdded ??= node;
        }
        if (node.parentElement) touched.add(node.parentElement);
      }
    }
    // Parser records include both a parent and its descendants. Traverse each
    // inserted subtree once, then register each matching item once this delivery.
    for (const el of added) if (!insideAdded(el.parentElement)) collect(el, candidates);
    for (const el of touched) {
      if (insideAdded(el)) continue;
      const owner = el.closest(selector);
      if (owner) candidates.add(owner);
      const module = modules ? el.closest(modules) : null;
      if (module) candidates.add(module);
    }
    for (const el of candidates) observe(el);
    if (inUpdate) flush("mutation");
    if (globalThis.__JEV_QA_ENABLE__ === true) qa.callbackDurations.push(host.now() - started);
  });

  const style = document.getElementById("jev-declutter") ?? document.createElement("style");
  style.id = "jev-declutter";
  style.textContent = ITEM_CSS;
  if (!style.isConnected) (document.head ?? document.documentElement).append(style);
  function frame() {
    if (stopped || document.hidden) { frameId = undefined; inUpdate = false; return; }
    frameId = host.frame(frame);
    inUpdate = true;
    // PaintTiming entries can arrive frames late. Snapshot content now, not in
    // the task: an item connected after a blank frame has not been presented.
    // checkVisibility is the rendered-box predicate: a cell parked inside a
    // display:none ancestor reports its own display:block, so getComputedStyle
    // would witness a frame that showed nothing. It is false while detached and
    // for items this scanner hid, which keeps the blank frame a non-witness.
    const contentFrame = !contentFramePainted && [...pending, ...states.keys()].some(
      (el) => el.checkVisibility()
    );
    host.postTask(() => {
      if (contentFrame && !document.hidden) contentFramePainted = true;
      inUpdate = false;
    });
  }
  function visibility() {
    if (frameId !== undefined) host.cancelFrame(frameId);
    frameId = undefined; inUpdate = false;
    if (!document.hidden) frameId = host.frame(frame);
  }
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("popstate", navigation);
  if (cfg.navEvent) window.addEventListener(cfg.navEvent, navigation);
  document.addEventListener("DOMContentLoaded", initial);
  visibility();
  initial();
  // No await precedes observer installation or the default-settings initial scan.
  const settingsPromise = host.settings().catch(() => DEFAULT_SETTINGS);
  const cachePromise = host.cache().catch(() => undefined);
  void settingsPromise.then((loaded) => {
    if (stopped) return;
    const changed = JSON.stringify(settings) !== JSON.stringify(loaded);
    settings = loaded;
    if (!changed) return;
    if (!settings.sites[cfg.id].enabled && pageHasPainted()) return;
    if (!settings.sites[cfg.id].enabled) {
      for (const el of states.keys()) { el.removeAttribute("data-jev"); el.removeAttribute("data-jev-held"); }
      return;
    }
    processed = new WeakMap();
    for (const el of states.keys()) observe(el);
    initial();
  });
  void Promise.all([settingsPromise, cachePromise]).then(([, loaded]) => {
    if (stopped) return;
    cache = ensureCurrent(loaded, today(), providerKey(settings)); cacheReady = true;
    for (const el of pending) { applyRO.unobserve(el); applyRO.observe(el); }
  });

  return {
    qa,
    nextSettings(value: Settings) { nextSettings = value; },
    updateCache(value: SignatureCache | undefined) {
      const incoming = ensureCurrent(value, today(), providerKey(settings));
      cache = remember(cache, incoming.entries);
      for (const [el, state] of states) {
        if (lookup(cache, state.key)) { processed.delete(el); observe(el); }
      }
    },
    stop() {
      stopped = true; generation++;
      disconnectMO(); applyRO.disconnect(); nearIO.disconnect();
      if (frameId !== undefined) host.cancelFrame(frameId);
      if (timerId !== undefined) host.cancelTimer(timerId);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("DOMContentLoaded", initial);
      window.removeEventListener("popstate", navigation);
      if (cfg.navEvent) window.removeEventListener(cfg.navEvent, navigation);
      states.clear(); pending.clear(); queue.clear(); priority.clear();
    }
  };
}
