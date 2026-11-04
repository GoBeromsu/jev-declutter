import { clearOverCap, ensureCurrent, freshCache, loadSigCache, lookup, MAX_ITEMS, modelGroupCap, providerKey, recordOverCap, remember } from "./cache";
import { actionFor, actionsOf, combine, COLLAPSE_CSS, ITEM_CSS, onScreen, readingDrift, today, type ReadingPosition } from "./decide";
import { createOverlay, type OverlayHost, type OverlayOrigin, type OverlayRect } from "./overlay";
import { emptyOverrides, loadOverrides, lookupOverride, saveOverride, type OverrideDecision, type OverrideMap } from "./overrides";
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
  overCap(keys: readonly string[]): void;
  overrides(): Promise<OverrideMap | undefined>;
  override(key: string, decision: OverrideDecision): void;
  overlay: OverlayHost;
  elementAt(x: number, y: number): Element | null;
  scrollY(): number;
  scrollBy(dy: number): void;
}

const READING_ANCHOR_HEIGHTS = [1 / 2, 1 / 4, 3 / 4];
const READING_HOLD_FRAMES = 3;

function browserHost(cfg: SiteConfig): ScanHost {
  const overlay = createOverlay(() => undefined);
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
    cancelTimer: (id) => window.clearTimeout(id),
    overCap: (keys) => { void recordOverCap(cfg.id, keys).catch(() => undefined); },
    overrides: () => loadOverrides(cfg.id),
    override: (key, decision) => {
      void saveOverride(cfg.id, key, decision)
        .then(() => (decision === "keep" ? clearOverCap(cfg.id, key) : undefined))
        .catch(() => undefined);
    },
    overlay,
    elementAt: (x, y) => document.elementFromPoint(x, y),
    scrollY: () => window.scrollY,
    scrollBy: (dy) => window.scrollBy({ top: dy, behavior: "instant" })
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
  let overrides: OverrideMap = emptyOverrides();
  let answerEpoch = 0;
  let cacheReady = false;
  let stopped = false;
  let path = location.pathname;
  let contentFramePainted = false;
  const pageHasPainted = () => contentFramePainted || host.painted();
  let frameId: number | undefined;
  let timerId: number | undefined;
  let pauseUntil = 0;
  let warnedNoKey = false;
  let generation = 0;
  let n = 0;
  let processed = new WeakMap<Element, string>();
  const states = new Map<Element, ItemState>();
  const pending = new Set<Element>();
  const queue = new Map<string, ItemDescriptor>();
  const inflight = new Set<string>();
  const answers = new Map<string, { ad: number | null; suggested: number | null }>();
  const charges = new Map<string, Set<Element>>();
  let chargedUnder = new WeakMap<Element, string>();
  const overCapped = new Set<string>();
  let reportedOverCap = 0;
  let readingHold: { anchor: Element; watcher: Observer; last: ReadingPosition; collapsedAbove: number; frames: number } | undefined;
  let observedItems = 0;
  let observedSeen = new WeakSet<Element>();
  const priority = new Set<Element>();
  const modules = cfg.modules.map((m) => m.selector).join(",");
  const selector = [cfg.item, modules].filter(Boolean).join(",");
  const qa = { processed: 0, observedItems: 0, applyPaths: new WeakMap<Element, "ro" | "mutation">() };
  const excluded = () => cfg.excludedPaths.some((re) => re.test(location.pathname));
  const active = () => !stopped && !excluded() && settings.sites[cfg.id].enabled;
  const actions = () => actionsOf(settings);
  const scoreAction = (s: { ad: number | null; suggested: number | null }) =>
    combine(actionFor("ad", s.ad, actions()), actionFor("suggested", s.suggested, actions()));

  const charged = (key: string, el: Element) => chargedUnder.get(el) === key;

  function charge(key: string, el: Element) {
    uncharge(el);
    const members = charges.get(key) ?? new Set<Element>();
    members.add(el);
    charges.set(key, members);
    chargedUnder.set(el, key);
  }

  function uncharge(el: Element) {
    const key = chargedUnder.get(el);
    if (key === undefined) return;
    chargedUnder.delete(el);
    const members = charges.get(key);
    if (members?.delete(el) && members.size === 0) charges.delete(key);
  }

  function liveCharges(key: string, budget: number): number {
    const members = charges.get(key);
    if (!members) return 0;
    if (members.size < budget) return members.size;
    for (const member of members) if (!member.isConnected) uncharge(member);
    return charges.get(key)?.size ?? 0;
  }

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
    releaseReadingHold();
    host.overlay.clear();
    charges.clear(); chargedUnder = new WeakMap(); overCapped.clear(); reportedOverCap = 0;
    observedItems = 0; observedSeen = new WeakSet(); qa.observedItems = 0;
    processed = new WeakMap();
    states.clear();
    if (!excluded()) for (const el of document.querySelectorAll("[data-jev-held]")) el.removeAttribute("data-jev-held");
    if (nextSettings) { settings = nextSettings; nextSettings = undefined; }
    cache = ensureCurrent(cache, today(), providerKey(settings));
    reloadOverrides();
    initial();
  }

  function reloadOverrides() {
    const sentGeneration = generation;
    const epoch = answerEpoch;
    void host.overrides().then((stored) => {
      if (stopped || generation !== sentGeneration || answerEpoch !== epoch) return;
      const next = stored ?? emptyOverrides();
      if (JSON.stringify(next.entries) === JSON.stringify(overrides.entries)) return;
      overrides = next;
      for (const el of states.keys()) { processed.delete(el); observe(el); }
    }).catch(() => undefined);
  }

  function schedule() {
    if (timerId !== undefined || queue.size === 0 || host.now() < pauseUntil || !active()) return;
    timerId = host.timer(send);
  }

  async function send() {
    timerId = undefined;
    if (!active() || host.now() < pauseUntil) return;
    for (const [el] of states) {
      if (!el.isConnected) {
        uncharge(el); states.delete(el); nearIO.unobserve(el); priority.delete(el);
        host.overlay.hide(el);
      }
    }
    const liveKeys = new Set([...states.values()].map((state) => state.key));
    for (const key of queue.keys()) if (!liveKeys.has(key)) queue.delete(key);
    const nearKeys = new Set([...priority].map((el) => states.get(el)?.key));
    const batch = [...queue.values()].sort((a, b) => Number(nearKeys.has(b.key)) - Number(nearKeys.has(a.key))).slice(0, MAX_ITEMS);
    if (batch.length === 0) return;
    for (const d of batch) { queue.delete(d.key); inflight.add(d.key); }
    const sentGeneration = generation;
    const result = await host.send({ type: "classify", site: cfg.id, items: batch })
      .catch((): ClassifyResult => ({ ok: false, error: "transport" }));
    if (stopped || generation !== sentGeneration) return;
    for (const d of batch) inflight.delete(d.key);
    if (!result.ok) {
      if (result.error === "http-429" || result.error === "budget") pauseUntil = host.now() + 60_000;
      if (result.error === "no-key" && !warnedNoKey) {
        warnedNoKey = true;
        console.warn("[jev-declutter]", "no-key", "save a provider API key on the extension options page");
      }
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

  const readPosition = (anchor: Element): ReadingPosition => ({ top: anchor.getBoundingClientRect().top, scrollY: host.scrollY() });

  function releaseReadingHold() {
    readingHold?.watcher.disconnect();
    readingHold = undefined;
  }

  function restoreReadingPosition() {
    if (!readingHold) return;
    if (!readingHold.anchor.isConnected) { releaseReadingHold(); return; }
    const position = readPosition(readingHold.anchor);
    const drift = readingDrift(readingHold.last, position, readingHold.collapsedAbove);
    readingHold.last = position;
    if (drift === 0) return;
    readingHold.collapsedAbove += drift;
    host.scrollBy(drift);
  }

  function readingHoldFrame() {
    restoreReadingPosition();
    if (!readingHold) return;
    if (--readingHold.frames <= 0) { releaseReadingHold(); return; }
    readingHold.watcher.unobserve(readingHold.anchor);
    readingHold.watcher.observe(readingHold.anchor);
  }

  function readingAnchor(x: number, doomed: (el: Element) => boolean): Element | undefined {
    for (const height of READING_ANCHOR_HEIGHTS) {
      let hit = host.elementAt(x, innerHeight * height);
      if (!hit?.closest(selector) || doomed(hit)) continue;
      while (hit.clientHeight === 0 && hit.parentElement && !hit.matches(selector)) hit = hit.parentElement;
      const blockChildOf = (el: Element) => [...el.children].find((child) => child.clientHeight > 0 && !doomed(child));
      for (let child = blockChildOf(hit); child; child = blockChildOf(hit)) hit = child;
      return hit;
    }
    return undefined;
  }

  function holdReadingPosition(collapsing: readonly OverlayRect[], doomed: (el: Element) => boolean) {
    if (collapsing.length === 0) return;
    const kept = readingHold && !doomed(readingHold.anchor) ? readingHold.anchor : undefined;
    const startingAbove = collapsing.find((rect) => rect.top < 0);
    const anchor = kept ?? (startingAbove && readingAnchor(startingAbove.left + startingAbove.width / 2, doomed));
    if (!anchor) { releaseReadingHold(); return; }
    const position = readPosition(anchor);
    const collapsedAbove = collapsing.reduce((sum, rect) => (rect.top < position.top ? sum + rect.height : sum), 0);
    if (readingHold && kept) {
      readingHold.collapsedAbove += collapsedAbove;
      readingHold.frames = READING_HOLD_FRAMES;
      return;
    }
    releaseReadingHold();
    const watcher = host.resize(restoreReadingPosition);
    readingHold = { anchor, watcher, last: position, collapsedAbove, frames: READING_HOLD_FRAMES };
    watcher.observe(anchor);
  }

  function flush(applyPath: "ro" | "mutation") {
    if (!active()) return;
    cache = ensureCurrent(cache, today(), providerKey(settings));
    const writes: {
      el: Element; want: Action; top: number; reveal: boolean; key: string; charge?: string;
      model: boolean; rect: OverlayRect;
    }[] = [];
    const painted = pageHasPainted();
    let origin: OverlayOrigin | undefined;
    const claimed = new Map<string, number>();
    for (const el of pending) {
      applyRO.unobserve(el);
      if (!el.isConnected) {
        uncharge(el);
        host.overlay.hide(el);
        pending.delete(el); states.delete(el); nearIO.unobserve(el); priority.delete(el); continue;
      }
      const isModule = modules !== "" && el.matches(modules);
      let state = states.get(el);
      let key: string;
      let descriptor: ItemDescriptor | undefined;
      let want: Action | undefined;
      let chargeKey: string | undefined;
      let fromModel = false;
      if (isModule) {
        key = "module"; want = actions().suggested;
      } else {
        const signals = extractSignals(el, cfg);
        descriptor = toDescriptor(n++, el, cfg, signals);
        key = descriptor.key;
        if (!observedSeen.has(el)) { observedSeen.add(el); qa.observedItems = ++observedItems; }
        const local = deterministic(signals, cfg);
        if (local) want = actionFor(local.category, local.p, actions());
        else if (!cacheReady) continue;
        else {
          const override = lookupOverride(overrides, key);
          const scores = override ? undefined : lookup(cache, key) ?? answers.get(key);
          if (override) want = override.decision === "keep" ? "keep" : "hide";
          else if (scores) {
            fromModel = true;
            want = scoreAction(scores);
            if (want !== "keep" && !charged(key, el)) {
              const budget = modelGroupCap(observedItems) - (claimed.get(key) ?? 0);
              if (liveCharges(key, budget) >= budget) {
                want = "keep";
                overCapped.add(key);
              } else {
                chargeKey = key;
                claimed.set(key, (claimed.get(key) ?? 0) + 1);
              }
            }
          }
          else if (signals.chromeText.length === 0 && signals.withheldSlots === 0 && !signals.followButton && !signals.hasExternalLink && signals.media === "none") want = "keep";
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
      const box = el.getBoundingClientRect();
      if (fromModel && desired !== "keep") origin ??= host.overlay.origin();
      writes.push({ el, want: desired, reveal, key, charge: chargeKey, model: fromModel,
        rect: { top: box.top, left: box.left, width: box.width, height: box.height },
        top: reveal && painted ? revealTop(el) : box.top });
    }
    const heldBack = ({ el, reveal, top }: (typeof writes)[number]) =>
      el.hasAttribute("data-jev-held") || (reveal && painted && top < innerHeight);
    const actionOf = ({ el, want, model, top }: (typeof writes)[number]): Action =>
      model && want === "hide" && el.getAttribute("data-jev") !== "hide" &&
      onScreen({ pageHasPainted: painted, top, viewportHeight: innerHeight }) ? "blur" : want;
    const hiding = writes.filter((write) => !heldBack(write) && actionOf(write) === "hide");
    holdReadingPosition(
      hiding.filter(({ el, rect }) => el.getAttribute("data-jev") !== "hide" && rect.height > 0).map(({ rect }) => rect),
      (el) => hiding.some((write) => write.el.contains(el))
    );
    for (const write of writes) {
      const { el, key, charge: chargeKey, model, rect } = write;
      if (heldBack(write)) {
        el.setAttribute("data-jev-held", "");
        host.overlay.hide(el);
        continue;
      }
      const action = actionOf(write);
      if (action === "keep") el.removeAttribute("data-jev");
      else el.setAttribute("data-jev", action);
      if (model && action === "blur" && origin && rect.width > 0 && rect.height > 0) {
        host.overlay.show(el, key, rect, origin);
      } else host.overlay.hide(el);
      if (chargeKey !== undefined) charge(chargeKey, el);
      else if (action === "keep" || !charged(key, el)) uncharge(el);
      qa.applyPaths.set(el, applyPath);
    }
    if (overCapped.size > reportedOverCap) {
      reportedOverCap = overCapped.size;
      host.overCap([...overCapped]);
    }
    host.overlay.revalidate();
    schedule();
  }

  function answered(key: string, decision: OverrideDecision) {
    answerEpoch++;
    overrides = { entries: { ...overrides.entries, [key]: { decision, at: Date.now() } } };
    host.override(key, decision);
    for (const member of Array.from(charges.get(key) ?? [])) uncharge(member);
    if (decision === "keep" && overCapped.delete(key)) reportedOverCap--;
    for (const [el, state] of states) {
      if (state.key !== key) continue;
      state.want = undefined;
      processed.delete(el);
      observe(el);
    }
    flush("ro");
  }

  const applyRO = host.resize(() => flush("ro"));
  const nearIO = host.intersection((elements) => { for (const el of elements) priority.add(el); });
  const disconnectMO = host.mutations((records) => {
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
    const body = document.body;
    const bodyInserted = body !== null && records.some(record =>
      record.target === document.documentElement && [...record.addedNodes].includes(body)
    );
    if (bodyInserted) collect(document.documentElement, candidates);
    else for (const record of records) {
      if (record.target instanceof Element) {
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
    for (const el of added) if (!insideAdded(el.parentElement)) collect(el, candidates);
    for (const el of touched) {
      if (insideAdded(el)) continue;
      const owner = el.closest(selector);
      if (owner) candidates.add(owner);
      const module = modules ? el.closest(modules) : null;
      if (module) candidates.add(module);
    }
    for (const el of candidates) observe(el);
    flush("mutation");
  });

  host.overlay.answers(answered);
  const style = document.getElementById("jev-declutter") ?? document.createElement("style");
  style.id = "jev-declutter";
  style.textContent = cfg.collapseHidden ? ITEM_CSS + COLLAPSE_CSS : ITEM_CSS;
  if (!style.isConnected) (document.head ?? document.documentElement).append(style);
  function frame() {
    if (stopped || document.hidden) { frameId = undefined; return; }
    frameId = host.frame(frame);
    readingHoldFrame();
    const contentFrame = !contentFramePainted && [...pending, ...states.keys()].some(
      (el) => el.checkVisibility()
    );
    host.postTask(() => {
      if (contentFrame && !document.hidden) contentFramePainted = true;
    });
  }
  function visibility() {
    if (frameId !== undefined) host.cancelFrame(frameId);
    frameId = undefined;
    if (!document.hidden) frameId = host.frame(frame);
  }
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("popstate", navigation);
  if (cfg.navEvent) window.addEventListener(cfg.navEvent, navigation);
  document.addEventListener("DOMContentLoaded", initial);
  visibility();
  initial();
  const settingsPromise = host.settings().catch(() => DEFAULT_SETTINGS);
  const cachePromise = host.cache().catch(() => undefined);
  void settingsPromise.then((loaded) => {
    if (stopped) return;
    const changed = JSON.stringify(settings) !== JSON.stringify(loaded);
    settings = loaded;
    if (!changed) return;
    if (!settings.sites[cfg.id].enabled && pageHasPainted()) return;
    if (!settings.sites[cfg.id].enabled) {
      host.overlay.clear();
      for (const el of states.keys()) { el.removeAttribute("data-jev"); el.removeAttribute("data-jev-held"); }
      return;
    }
    processed = new WeakMap();
    for (const el of states.keys()) observe(el);
    initial();
  });
  const overridesPromise = host.overrides().catch(() => undefined);
  void Promise.all([settingsPromise, cachePromise, overridesPromise]).then(([, loaded, stored]) => {
    if (stopped) return;
    cache = ensureCurrent(loaded, today(), providerKey(settings)); cacheReady = true;
    overrides = stored ?? emptyOverrides();
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
      disconnectMO(); applyRO.disconnect(); nearIO.disconnect(); host.overlay.clear();
      releaseReadingHold();
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
