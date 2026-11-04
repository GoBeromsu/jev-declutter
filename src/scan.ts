import { clearOverCap, ensureCurrent, freshCache, loadSigCache, lookup, MAX_ITEMS, modelGroupCap, providerKey, recordOverCap, remember } from "./cache";
import { actionFor, actionsOf, combine, ITEM_CSS, placement, today } from "./decide";
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
  /** Diagnostics only: signalKeys whose model group hit its cap in this page view. */
  overCap(keys: readonly string[]): void;
  /** The user's stored answers for this site; they never expire with the daily cache. */
  overrides(): Promise<OverrideMap | undefined>;
  /** Persists one answer. Fire-and-forget: the page never waits for storage. */
  override(key: string, decision: OverrideDecision): void;
  overlay: OverlayHost;
}

function browserHost(cfg: SiteConfig): ScanHost {
  // The prompt is built before the scanner exists; startScanner registers the real sink.
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
    // A diagnostics hint must never break the scan: storage failure is simply no hint.
    overCap: (keys) => { void recordOverCap(cfg.id, keys).catch(() => undefined); },
    overrides: () => loadOverrides(cfg.id),
    // Nothing leaves the browser here: the key is the opaque signalKey, and a "not an ad" answer
    // also answers the over-cap note that named it.
    override: (key, decision) => {
      void saveOverride(cfg.id, key, decision)
        .then(() => (decision === "keep" ? clearOverCap(cfg.id, key) : undefined))
        .catch(() => undefined);
    },
    overlay
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
  let inUpdate = false;
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
  // Per page view: which DISTINCT elements each model verdict currently holds treated, which keys
  // ran out of budget, and how many distinct feed items this page view has shown the scanner.
  const charges = new Map<string, Set<Element>>();
  // The key each element was charged under: a held-then-recycled cell shows another key by the
  // time it is dropped, and the slot to free is the one that paid for what is on screen.
  let chargedUnder = new WeakMap<Element, string>();
  const overCapped = new Set<string>();
  let reportedOverCap = 0;
  let observedItems = 0;
  let observedSeen = new WeakSet<Element>();
  const priority = new Set<Element>();
  const modules = cfg.modules.map((m) => m.selector).join(",");
  const selector = [cfg.item, modules].filter(Boolean).join(",");
  const qa = { callbackDurations: [] as number[], processed: 0, observedItems: 0, applyPaths: new WeakMap<Element, "ro" | "mutation">() };
  const excluded = () => cfg.excludedPaths.some((re) => re.test(location.pathname));
  const active = () => !stopped && !excluded() && settings.sites[cfg.id].enabled;
  const actions = () => actionsOf(settings.hideSuggested);
  const scoreAction = (s: { ad: number | null; suggested: number | null }) =>
    combine(actionFor("ad", s.ad, actions()), actionFor("suggested", s.suggested, actions()));

  const charged = (key: string, el: Element) => chargedUnder.get(el) === key;

  /** One slot per element, so taking a new one always frees the old. */
  function charge(key: string, el: Element) {
    uncharge(el);
    const members = charges.get(key) ?? new Set<Element>();
    members.add(el);
    charges.set(key, members);
    chargedUnder.set(el, key);
  }

  /** Only a treatment that is genuinely gone frees its slot; a held item keeps it (D6). */
  function uncharge(el: Element) {
    const key = chargedUnder.get(el);
    if (key === undefined) return;
    chargedUnder.delete(el);
    const members = charges.get(key);
    if (members?.delete(el) && members.size === 0) charges.delete(key);
  }

  /**
   * A slot may only be held by a live treatment. A removal is not always announced - a fully cached
   * page view sends no batch, so nothing sweeps - therefore detached members are pruned here, at
   * the one decision point that spends the budget. A key under its budget costs one size read.
   */
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

  /**
   * An answer cleared on the options page must stop applying without a full page load, which is
   * what the options page tells the user. The in-memory copy is replaced only if this page view is
   * still the one that asked (generation) and no answer was given while the read was in flight
   * (answerEpoch), so a slow read can never undo the user's newest answer. Items are re-judged
   * only when the answers actually changed.
   */
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
    for (const [el, state] of states) {
      if (!el.isConnected) {
        uncharge(el); states.delete(el); nearIO.unobserve(el); priority.delete(el);
        // An item that left the page takes its prompt with it: a pill over whatever moved up into
        // its place would answer for a skeleton the user never judged.
        host.overlay.hide(el);
      }
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
      // One diagnostic per page load: the missing key is a page-wide condition,
      // not a per-item or per-batch one. Never echo any stored key material.
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
    const writes: {
      el: Element; want: Action; top: number; reveal: boolean; key: string; charge?: string;
      model: boolean; rect: OverlayRect;
    }[] = [];
    const painted = pageHasPainted();
    // One geometry read of the prompt layer per flush, taken only when a prompt may be needed.
    let origin: OverlayOrigin | undefined;
    // Slots claimed earlier in THIS flush, so items of one key cannot all read the same count.
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
        // The cap's denominator: distinct feed items this page view has shown us, modules excluded.
        if (!observedSeen.has(el)) { observedSeen.add(el); qa.observedItems = ++observedItems; }
        const local = deterministic(signals, cfg);
        if (local) want = actionFor(local.category, local.p, actions());
        else if (!cacheReady) continue;
        else {
          const override = lookupOverride(overrides, key);
          const scores = override ? undefined : lookup(cache, key) ?? answers.get(key);
          // Precedence is deterministic > user override > cache/model, and an override is also an
          // answer FOR the key: the model is never asked about it again, so answering costs no
          // request, takes no cap slot and offers no further prompt.
          if (override) want = override.decision === "keep" ? "keep" : actionFor("ad", 1, actions());
          else if (scores) {
            fromModel = true;
            want = scoreAction(scores);
            // One model answer is a single judgement about a skeleton, not evidence about each
            // item wearing it. While it already holds a quarter of this page view's items treated,
            // the group size is itself evidence of the site's common organic card: fail open
            // (IS-8) and leave every further item untouched. An item this verdict already holds
            // treated keeps its treatment and its slot, so nothing on screen is ever withdrawn.
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
          // Nothing to judge - no chrome, no follow button, no outbound link, no media - so the
          // model would be paid for an empty descriptor. `withheldSlots === 0` is load-bearing: a
          // slot the privacy rule silenced (its text was an author name) leaves chromeText empty
          // while the card DOES have chrome, and such an item must still be asked about, as a
          // structure-only descriptor (todo 27 gate finding F1).
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
    // Complete every geometry read before the first attribute write.
    for (const { el, want, top, reveal, key, charge: chargeKey, model, rect } of writes) {
      if (el.hasAttribute("data-jev-held") || (reveal && painted && top < innerHeight)) {
        el.setAttribute("data-jev-held", "");
        // What is on screen is a stale verdict, not the current one: there is nothing to confirm.
        host.overlay.hide(el);
        // The previous verdict is still the one on screen, so it keeps its slot - and because a
        // claim is only committed below, the verdict that was not applied takes none.
        continue;
      }
      // Placement may cover a visible item, never reveal one already collapsed - and an item
      // that was ever on screen (blurred or covered) is never collapsed later, only covered.
      const current = el.getAttribute("data-jev");
      let action = current === "hide" && want === "hide"
        ? "hide"
        : placement(want, { pageHasPainted: painted, top, viewportHeight: innerHeight });
      if ((current === "blur" || current === "cover") && action === "hide") action = "cover";
      // A model verdict is never certain: on screen it stays a blur with the yes/no prompt, and
      // only the user's "yes" (an override, not a model verdict) turns it into a cover.
      if (model && action === "cover") action = "blur";
      if (action === "keep") el.removeAttribute("data-jev");
      else el.setAttribute("data-jev", action);
      // The prompt belongs to a MODEL verdict that the placement rule BLURRED, and to nothing
      // else: a deterministic verdict is per-item evidence that needs no confirmation, a module is
      // not a feed item, and a hidden item is not on screen to point at. A zero-sized box has no
      // place to put a prompt either.
      if (model && action === "blur" && origin && rect.width > 0 && rect.height > 0) {
        host.overlay.show(el, key, rect, origin);
      } else host.overlay.hide(el);
      // The charge follows the treatment that is now on screen: this verdict takes the slot, or a
      // verdict whose treatment just went away (revealed, recycled, re-keyed) gives one back.
      if (chargeKey !== undefined) charge(chargeKey, el);
      else if (action === "keep" || !charged(key, el)) uncharge(el);
      qa.applyPaths.set(el, applyPath);
    }
    // One report per newly over-cap key, so the options page can name the signature to reset.
    if (overCapped.size > reportedOverCap) {
      reportedOverCap = overCapped.size;
      host.overCap([...overCapped]);
    }
    // Every re-layout the page does silently - content inserted above a prompted item, a cell
    // re-positioned, an item detached - reaches the scanner as a flush and nothing else. A prompt
    // is never moved to follow, so one that no longer covers its item is dropped here. Free while
    // no prompt is up, and it also re-checks geometry this flush's own writes may have changed.
    host.overlay.revalidate();
    schedule();
  }

  /**
   * A user answer replaces the model's guess about that whole skeleton. Both decisions re-run the
   * normal placement path for every item of the key, so no treatment is ever written outside the
   * one rule: "keep" releases them - an already hidden item inside the viewport still stays hidden
   * for this page view, because revealing it would move content under the cursor (IS-3/D6), and
   * the next navigation starts it from the override - while "confirmed" keeps what is on screen.
   */
  function answered(key: string, decision: OverrideDecision) {
    answerEpoch++;
    overrides = { entries: { ...overrides.entries, [key]: { decision, at: Date.now() } } };
    host.override(key, decision);
    // The model verdict's cap slots go back either way: the user has now judged this key, so it is
    // no longer a shared guess spending this page view's budget.
    for (const member of [...(charges.get(key) ?? [])]) uncharge(member);
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

  host.overlay.answers(answered);
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
      host.overlay.clear();
      for (const el of states.keys()) { el.removeAttribute("data-jev"); el.removeAttribute("data-jev-held"); }
      return;
    }
    processed = new WeakMap();
    for (const el of states.keys()) observe(el);
    initial();
  });
  const overridesPromise = host.overrides().catch(() => undefined);
  // One gate for both: an unknown item waits until the user's answers are known, so a key the
  // user already judged can never produce a model request on a fresh page load.
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
