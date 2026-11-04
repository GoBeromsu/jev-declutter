import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startScanner, type ScanHost, type Mutation } from "../src/scan";
import type { OverrideDecision, OverrideMap } from "../src/overrides";
import { deterministic } from "../src/rules";
import { SITES, type SiteConfig } from "../src/sites";
import { DEFAULT_SETTINGS } from "../src/storage";
import { freshCache, MAX_ITEMS, MIN_MODEL_GROUP, modelGroupCap, providerKey } from "../src/cache";
import { today } from "../src/decide";
import { extractSignals, toDescriptor } from "../src/signals";
import type { ClassifyResult, Message, Settings, SignatureCache } from "../src/types";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); document.body.innerHTML = ""; });

function harness(cfg = SITES.x) {
  document.body.innerHTML = "";
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  window.location.href = "https://x.com/home";
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: window.location });
  cleanups.push(() => { if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); });
  const settings = deferred<Settings>();
  const cache = deferred<SignatureCache | undefined>();
  const overrides = deferred<OverrideMap | undefined>();
  // The first read is the page-load one; later reads (an SPA navigation) see the current store.
  let storedOverrides: OverrideMap | undefined;
  let overrideReads = 0;
  let lastOverrideRead: Promise<OverrideMap | undefined> = overrides.promise;
  const calls: Message[] = [];
  const overCapped: string[][] = [];
  const saved: { key: string; decision: OverrideDecision }[] = [];
  const prompts = new Map<Element, string>();
  let answer: (key: string, decision: OverrideDecision) => void = () => {};
  const targets = new Set<Element>();
  const observations: Element[] = [];
  let mutation: (records: readonly Mutation[]) => void = () => {};
  let resize: () => void = () => {};
  let near: (elements: Element[]) => void = () => {};
  let frame: FrameRequestCallback | undefined;
  let task: (() => void) | undefined;
  let timer: (() => void) | undefined;
  let painted = false;
  let now = 0;
  let response: (message: Message) => Promise<ClassifyResult> = async () => ({ ok: true, scores: [{ ad: 0, suggested: 0.9 }] });
  const host: ScanHost = {
    settings: () => settings.promise, cache: () => cache.promise,
    send: async (msg) => { calls.push(msg); return response(msg); },
    painted: () => painted, now: () => now,
    mutations: (cb) => { mutation = cb; return () => {}; },
    resize: (cb) => { resize = cb; return { observe: (el) => { targets.add(el); observations.push(el); }, unobserve: (el) => { targets.delete(el); }, disconnect: () => targets.clear() }; },
    intersection: (cb) => { near = cb; return { observe: () => {}, unobserve: () => {}, disconnect: () => {} }; },
    frame: (cb) => { frame = cb; return 1; }, cancelFrame: () => { frame = undefined; },
    postTask: (cb) => { task = cb; },
    timer: (cb) => { timer = cb; return 1; }, cancelTimer: () => { timer = undefined; },
    overCap: (keys) => { overCapped.push([...keys]); },
    overrides: () => {
      lastOverrideRead = overrideReads++ === 0 ? overrides.promise : Promise.resolve(storedOverrides);
      return lastOverrideRead;
    },
    override: (key, decision) => { saved.push({ key, decision }); },
    overlay: {
      answers: (cb) => { answer = cb; },
      origin: () => ({ top: 0, left: 0 }),
      show: (el, key) => { prompts.set(el, key); },
      hide: (el) => { prompts.delete(el); },
      // The real one also drops a prompt whose item moved; geometry is stubbed here, so this
      // fake models the rule the scanner depends on: an item that left the page loses its prompt.
      revalidate: () => { for (const el of [...prompts.keys()]) if (!el.isConnected) prompts.delete(el); },
      clear: () => { prompts.clear(); }
    }
  };
  const scanner = startScanner(cfg, host);
  cleanups.push(scanner.stop);
  return {
    settings, cache, overrides, calls, overCapped, saved, prompts, targets, observations, scanner,
    prompt: (el: Element) => prompts.get(el),
    answer: (key: string, decision: OverrideDecision) => answer(key, decision),
    setOverrides: (value: OverrideMap | undefined) => { storedOverrides = value; },
    overridesRead: () => lastOverrideRead,
    painted: () => { painted = true; },
    time: (value: number) => { now = value; },
    response: (fn: (message: Message) => Promise<ClassifyResult>) => { response = fn; },
    mutate: (target: Node, addedNodes: Node[] = []) => mutation([{ target, addedNodes }]),
    mutations: (records: readonly Mutation[]) => mutation(records),
    flush: () => resize(),
    frame: () => { const cb = frame; frame = undefined; cb?.(now); },
    task: () => { const cb = task; task = undefined; cb?.(); },
    hasFrame: () => frame !== undefined,
    near: (elements: Element[]) => near(elements),
    send: async () => { const cb = timer; timer = undefined; await cb?.(); },
    ready: async (value = DEFAULT_SETTINGS, c?: SignatureCache, o?: OverrideMap) => {
      storedOverrides = o;
      settings.resolve(value); cache.resolve(c); overrides.resolve(o);
      await settings.promise; await cache.promise; await overrides.promise;
    }
  };
}

function item(label = "Sponsored", top = 1000) {
  const el = document.createElement("div");
  el.dataset.testid = "cellInnerDiv";
  if (label) el.innerHTML = `<div data-testid="socialContext">${label}</div>`;
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 }) });
  document.body.append(el);
  return el;
}

for (const path of ["ro", "mutation"] as const) {
  for (const [painted, top, expected] of [[false, 0, "hide"], [true, 0, "cover"], [true, 2000, "hide"]] as const) {
    test(`${path} independently places painted=${painted} top=${top} as ${expected}`, () => {
      // Given
      const h = harness();
      if (painted) h.painted();
      if (path === "mutation") h.frame();
      const el = item("Sponsored", top);
      // When
      h.mutate(document.body, [el]);
      if (path === "ro") { expect(el.hasAttribute("data-jev")).toBe(false); h.flush(); }
      // Then
      expect(el.getAttribute("data-jev")).toBe(expected);
      expect(h.scanner.qa.applyPaths.get(el)).toBe(path);
    });
  }
}

test("default settings mark deterministic items while storage remains unresolved", () => {
  const h = harness(); const el = item();
  h.mutate(document.body, [el]); h.flush();
  expect(el.dataset.jev).toBe("hide");
});

test("unknown waits for cache then model response uses late placement", async () => {
  const h = harness(); const el = item("2h", 0);
  h.mutate(document.body, [el]); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false); expect(h.calls).toHaveLength(0);
  await h.ready(); h.flush(); h.painted();
  await h.send(); h.flush();
  expect(h.calls).toHaveLength(1); expect(el.dataset.jev).toBe("blur");
});

test("cache hit applies without a request and wrong provider cache is ignored", async () => {
  const h = harness(); const el = item("2h");
  const d = toDescriptor(0, el, SITES.x, extractSignals(el, SITES.x));
  const c = freshCache(today(), providerKey(DEFAULT_SETTINGS)); c.entries[d.key] = { ad: 1, suggested: 0 }; c.order.push(d.key);
  await h.ready(DEFAULT_SETTINGS, c); h.mutate(document.body, [el]); h.flush(); await h.send();
  expect(el.dataset.jev).toBe("hide"); expect(h.calls).toHaveLength(0);
});

test("another provider cache cannot hide an unknown item", async () => {
  const h = harness(); const el = item("2h");
  const d = toDescriptor(0, el, SITES.x, extractSignals(el, SITES.x));
  const c = freshCache(today(), "other"); c.entries[d.key] = { ad: 1, suggested: 0 }; c.order.push(d.key);
  await h.ready(DEFAULT_SETTINGS, c); h.mutate(document.body, [el]); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false);
  await h.send(); expect(h.calls).toHaveLength(1);
});

for (const below of [true, false]) {
  test(`recycled same skeleton clears stale treatment only below viewport=${below}`, async () => {
    const h = harness(); await h.ready();
    const previous = item("", below ? 2000 : 0); const el = item();
    h.mutate(document.body, [previous, el]); h.flush(); h.painted();
    el.innerHTML = '<div data-testid="socialContext">2h</div>';
    h.mutate(el, [...el.childNodes]); h.flush();
    expect(el.dataset.jev).toBe(below ? undefined : "hide");
    expect(el.hasAttribute("data-jev-held")).toBe(!below);
  });
  test(`late settings reveal only below viewport=${below}`, async () => {
    const h = harness(); const previous = item("", below ? 2000 : 0); const el = item("Suggested");
    h.mutate(document.body, [previous, el]); h.flush(); h.painted();
    await h.ready({ ...DEFAULT_SETTINGS, hideSuggested: false }); h.flush();
    expect(el.dataset.jev).toBe(below ? undefined : "hide");
    expect(el.hasAttribute("data-jev-held")).toBe(!below);
  });
}

for (const [cfg, path, feed] of [[SITES.x, "/messages", "/home"], [SITES.instagram, "/direct", "/"], [SITES.linkedin, "/messaging", "/feed"]] as const) {
  test(`${path} constructs zero descriptors and transition scans existing items`, async () => {
    const h = harness(cfg); window.history.pushState(null, "", path);
    const el = item(); h.mutate(document.body, [el]); h.flush();
    expect(h.scanner.qa.processed).toBe(0); expect(h.calls).toHaveLength(0);
    if (cfg.id === "x") {
      window.history.pushState(null, "", feed);
      expect(location.pathname).toBe(feed);
      expect(el.isConnected).toBe(true);
      h.mutate(document.body); h.flush();
      expect(el.dataset.jev).toBe("hide");
    }
  });
}

test("runtime rejection fails open", async () => {
  const h = harness(); await h.ready(); h.response(() => Promise.reject(new Error("Receiving end does not exist")));
  const el = item("2h"); h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false);
});

test("429 suppresses sends for sixty seconds without retry loops", async () => {
  const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error: "http-429" }));
  const el = item("2h"); h.mutate(document.body, [el]); h.flush(); await h.send();
  h.time(59_999); const second = item("3h"); h.mutate(document.body, [second]); h.flush(); await h.send();
  expect(h.calls).toHaveLength(1); expect(el.hasAttribute("data-jev")).toBe(false);
  h.time(60_000); const third = item("4h"); h.mutate(document.body, [third]); h.flush(); await h.send();
  expect(h.calls).toHaveLength(2);
});

test("500 items share answers and respect the shared request cap", async () => {
  const h = harness(); await h.ready();
  const keys = MAX_ITEMS + 5;
  const els = Array.from({ length: 500 }, (_, i) => item(`${i % keys}h`));
  h.mutate(document.body, els); h.flush(); await h.send(); h.flush();
  const first = h.calls[0]; expect(first?.type).toBe("classify");
  if (first?.type === "classify") expect(first.items).toHaveLength(MAX_ITEMS);
  expect(els[0]?.dataset.jev).toBe("hide"); expect(els[keys]?.dataset.jev).toBe("hide");
});

test("removed item and item without signals fail open without stale writes", async () => {
  const h = harness(); await h.ready(); const el = item(""); h.mutate(document.body, [el]); el.remove();
  h.mutate(document.body); h.flush(); await h.send();
  expect(h.calls).toHaveLength(0); expect(el.hasAttribute("data-jev")).toBe(false);
});

/**
 * The "no signals at all -> keep without asking" branch must read ABSENT chrome, not WITHHELD
 * chrome. `src/signals.ts` withholds a label slot's text when the slot sits inside a link, because
 * that text is an author name; the slot still exists and the item is still undecided, so it has to
 * reach the model. Reading the two as the same thing took Instagram's model path to zero (todo 27
 * gate finding F1): 13 of 19 items per fixture, including the one the fixture's own ground truth
 * says must end up blurred or hidden.
 */
test("a withheld label slot still reaches the model, with no name on the wire", async () => {
  const h = harness(); await h.ready();
  const el = document.createElement("div");
  el.dataset.testid = "cellInnerDiv";
  el.innerHTML = '<a href="#/member1" role="link"><div data-testid="socialContext">Member One Display Name</div></a>';
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top: 2000, bottom: 2100, width: 100, height: 100 }) });
  document.body.append(el);
  const signals = extractSignals(el, SITES.x);
  expect(signals.chromeText).toEqual([]);
  expect(signals.withheldSlots).toBe(1);
  expect(deterministic(signals, SITES.x)).toBeNull();
  h.mutate(document.body, [el]); h.flush(); await h.send();
  expect(h.calls).toHaveLength(1);
  const message = h.calls[0];
  if (message?.type !== "classify") throw new Error("expected a classify message");
  expect(message.items).toHaveLength(1);
  expect(message.items[0]?.chrome_text).toEqual([]);
  expect(JSON.stringify(message.items)).not.toContain("Member");
  expect(Object.keys(message.items[0] ?? {})).not.toContain("withheldSlots");
  h.flush();
  expect(el.dataset.jev).toBe("hide");
});

test("an item whose chrome is genuinely absent is still kept locally without a request", async () => {
  const h = harness(); await h.ready();
  const el = item("", 2000);
  expect(extractSignals(el, SITES.x).withheldSlots).toBe(0);
  h.mutate(document.body, [el]); h.flush(); await h.send();
  expect(h.calls).toHaveLength(0);
  expect(el.hasAttribute("data-jev")).toBe(false);
});

/** Real fixture items in the harness DOM, with the rect stub `item()` uses. */
function fixtureItems(file: string, cfg: SiteConfig, top = 2000): Element[] {
  const doc = new DOMParser().parseFromString(readFileSync(join(import.meta.dir, "fixtures", file), "utf8"), "text/html");
  const out: Element[] = [];
  for (const source of doc.querySelectorAll(cfg.item)) {
    const el = document.importNode(source, true);
    Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + 100, width: 100, height: 100 }) });
    document.body.append(el);
    out.push(el);
  }
  return out;
}

for (const file of ["instagram-en.html", "instagram-ko.html"]) {
  test(`${file}: every undecided item reaches the model, deduped to its distinct keys`, async () => {
    const cfg = SITES.instagram;
    const h = harness(cfg); await h.ready();
    const items = fixtureItems(file, cfg);
    expect(items).toHaveLength(19);
    const undecided = items.filter((el) => deterministic(extractSignals(el, cfg), cfg) === null);
    expect(undecided).toHaveLength(13);
    const keyOfItem = (el: Element): string => toDescriptor(0, el, cfg, extractSignals(el, cfg)).key;
    const keys = new Set(undecided.map(keyOfItem));
    // The measured cost of asking: 2 requests for this page view, not 13. Withholding the per-item
    // account name is what collapses the 12 organic cards onto one key.
    expect(keys.size).toBe(2);
    const modelItem = undecided.find((el) => el.hasAttribute("data-qa-model"));
    if (!modelItem) throw new Error("fixture lost its data-qa-model item");
    expect(modelItem.getAttribute("data-qa-expect")).toBe("blur-or-hide");
    const modelKey = keyOfItem(modelItem);
    h.response(async (message) =>
      message.type === "classify"
        ? { ok: true, scores: message.items.map((i) => (i.key === modelKey ? { ad: null, suggested: 0.9 } : { ad: 0.1, suggested: 0.1 })) }
        : { ok: true, scores: [] });
    h.mutate(document.body, items); h.flush(); await h.send(); h.flush();
    const sent = h.calls.flatMap((c) => (c.type === "classify" ? c.items.map((i) => i.key) : []));
    expect(new Set(sent)).toEqual(keys);
    expect(modelItem.getAttribute("data-jev")).toBe("hide");
    expect(undecided.filter((el) => el !== modelItem && el.hasAttribute("data-jev"))).toEqual([]);
    for (const c of h.calls) {
      if (c.type !== "classify") continue;
      expect(c.items.every((i) => i.chrome_text.length === 0)).toBe(true);
    }
  });
}

test("rAF re-registers each frame and repeated visibility interruptions restart it", () => {
  const h = harness(); h.frame(); expect(h.hasFrame()).toBe(true); h.task();
  const original = Object.getOwnPropertyDescriptor(document, "hidden");
  for (let i = 0; i < 3; i++) {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange")); expect(h.hasFrame()).toBe(false);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange")); expect(h.hasFrame()).toBe(true);
  }
  if (original) Object.defineProperty(document, "hidden", original);
  else Reflect.deleteProperty(document, "hidden");
});

test("module recognized after child insertion goes through placement", () => {
  const h = harness(); h.painted();
  const aside = document.createElement("aside"); aside.setAttribute("aria-label", "Subscribe to Premium"); document.body.append(aside);
  h.mutate(aside, [document.createElement("span")]); h.flush();
  expect(aside.dataset.jev).toBe("cover");
});

test("all geometry reads precede writes in one flush", () => {
  const h = harness(); const first = item(); const second = item();
  const reads: boolean[] = [];
  for (const el of [first, second]) Object.defineProperty(el, "getBoundingClientRect", {
    value: () => { reads.push(first.hasAttribute("data-jev")); return { top: 2000 }; }
  });
  h.mutate(document.body, [first, second]); h.flush();
  expect(reads).toEqual([false, false]);
});

test("queued item removed before send never leaves the browser", async () => {
  const h = harness(); await h.ready(); const el = item("2h");
  h.mutate(document.body, [el]); h.flush(); el.remove(); h.mutate(document.body); await h.send();
  expect(h.calls).toHaveLength(0);
});

test("before-paint settings can fully disable and reveal previous defaults", async () => {
  const h = harness(); const el = item(); h.mutate(document.body, [el]); h.flush();
  await h.ready({ ...DEFAULT_SETTINGS, sites: { ...DEFAULT_SETTINGS.sites, x: { enabled: false } } });
  expect(el.hasAttribute("data-jev")).toBe(false);
});

test("after-paint disable preserves treatment even below viewport and stops new work", async () => {
  const h = harness(); const el = item(); h.mutate(document.body, [el]); h.flush(); h.painted();
  await h.ready({ ...DEFAULT_SETTINGS, sites: { ...DEFAULT_SETTINGS.sites, x: { enabled: false } } });
  const second = item(); h.mutate(document.body, [second]); h.flush();
  expect(el.dataset.jev).toBe("hide"); expect(second.hasAttribute("data-jev")).toBe(false);
});

test("a cover never collapses to hide when a later cache verdict arrives below viewport", async () => {
  const h = harness(); await h.ready(); h.painted(); const el = item("Sponsored", 0);
  h.mutate(document.body, [el]); h.flush();
  Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ top: 2000 }) });
  h.mutate(el); h.flush();
  expect(el.dataset.jev).toBe("cover");
});

test("settings changes are deferred until navigation", async () => {
  const h = harness(); await h.ready(); const el = item("Suggested");
  h.scanner.nextSettings({ ...DEFAULT_SETTINGS, hideSuggested: false });
  h.mutate(document.body, [el]); h.flush(); expect(el.dataset.jev).toBe("hide");
  window.history.pushState(null, "", "/search"); h.mutate(document.body); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false);
});

test("viewport priority reorders keys but does not defer classification", async () => {
  const h = harness(); await h.ready(); const els = Array.from({ length: 25 }, (_, i) => item(`${i}h`));
  h.mutate(document.body, els); h.flush();
  const last = els[24]; if (!last) throw new Error("missing fixture");
  h.near([last]); await h.send();
  const message = h.calls[0];
  if (message?.type !== "classify") throw new Error("missing request");
  expect(message.items[0]?.chrome_text).toEqual(["24h"]);
});

test("post body stays out of descriptors sent by the scanner", async () => {
  const h = harness(); await h.ready(); const el = item("2h");
  el.innerHTML += '<div data-testid="tweetText"><div data-testid="socialContext">BODY_SENTINEL</div></div>';
  h.mutate(document.body, [el]); h.flush(); await h.send();
  const message = h.calls[0]; if (message?.type !== "classify") throw new Error("missing request");
  expect(message.items[0]?.chrome_text).toEqual(["2h"]);
});

test("cache update can resolve an earlier failed model answer", async () => {
  const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error: "offline" }));
  const el = item("2h"); h.mutate(document.body, [el]); h.flush(); await h.send();
  const d = toDescriptor(0, el, SITES.x, extractSignals(el, SITES.x));
  const c = freshCache(today(), providerKey(DEFAULT_SETTINGS)); c.entries[d.key] = { ad: 1, suggested: 0 }; c.order.push(d.key);
  h.scanner.updateCache(c); h.flush();
  expect(el.dataset.jev).toBe("hide");
});

test("new structural signature on a recycled cell removes stale treatment below viewport", async () => {
  const h = harness(); await h.ready(); const previous = item("", 2000); const el = item();
  h.mutate(document.body, [previous, el]); h.flush(); h.painted();
  el.innerHTML = '<article><div data-testid="socialContext">2h</div></article>';
  h.mutate(el, [...el.childNodes]); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false);
});

test("navigation into excluded route never touches held elements", () => {
  const h = harness(); const el = item(); h.mutate(document.body, [el]); h.flush();
  el.setAttribute("data-jev-held", "");
  window.history.pushState(null, "", "/messages"); h.mutate(document.body); h.flush();
  expect(el.hasAttribute("data-jev-held")).toBe(true);
  expect(h.scanner.qa.processed).toBe(1);
});

test("late has-module ancestor is found even across a nested feed item", () => {
  const h = harness({ ...SITES.x, modules: [{ selector: "section:has(aside)", description: "fixture module" }] });
  h.painted();
  const section = document.createElement("section"); document.body.append(section);
  const el = item("2h"); section.append(el);
  const aside = document.createElement("aside"); el.append(aside);
  h.mutate(el, [aside]); h.flush();
  expect(section.dataset.jev).toBe("cover");
});

test("content frame downgrades a late visible ad while paint entries remain empty", () => {
  // Given: the host's paint-entry source stays false throughout this test.
  const h = harness(); const visible = item("2h", 0);
  h.mutate(document.body, [visible]);
  h.frame(); h.task();
  const ad = item("Sponsored", 0);
  // When: discover after the content frame's post-frame task.
  h.mutate(document.body, [ad]); h.flush();
  // Then: RO placement must use presented content, not delayed paint entries.
  expect(ad.dataset.jev).toBe("cover");
  expect(h.scanner.qa.applyPaths.get(ad)).toBe("ro");
});

test("blank frame does not count content connected only after that frame", () => {
  // Given: an empty frame, with the paint-entry source still false.
  const h = harness(); h.frame();
  const visible = item("2h", 0);
  h.mutate(document.body, [visible]);
  h.task();
  const ad = item("Sponsored", 0);
  // When: discover before any content-bearing frame has completed.
  h.mutate(document.body, [ad]); h.flush();
  // Then: a blank pre-body frame must not consume the pre-paint hide window.
  expect(ad.dataset.jev).toBe("hide");
});

test("item parked inside a display:none ancestor never witnesses a painted frame", () => {
  // Given: an observed cell whose ancestor is display:none renders no box, even
  // though its own computed display stays block.
  const h = harness();
  const hidden = document.createElement("section");
  hidden.style.display = "none";
  document.body.append(hidden);
  const parked = item("2h", 0);
  hidden.append(parked);
  h.mutate(document.body, [hidden]);
  expect(h.targets.has(parked)).toBe(true);
  expect(getComputedStyle(parked).display).toBe("block");
  expect(parked.checkVisibility()).toBe(false);
  // When: frames complete while that hidden cell is the only observed content.
  h.frame(); h.task();
  h.frame(); h.task();
  hidden.style.display = "";
  const ad = item("Sponsored", 0);
  h.mutate(document.body, [ad]); h.flush();
  // Then: blank frames leave the pre-paint window open, so the initial
  // deterministic ad collapses to a zero box in its discovery flush.
  expect(ad.dataset.jev).toBe("hide");
  expect(getComputedStyle(ad).display).toBe("none");
  // And: once that cell is genuinely rendered it does latch the witness, so a
  // later in-view verdict is covered instead of collapsing presented content.
  h.frame(); h.task();
  const late = item("Sponsored", 0);
  h.mutate(document.body, [late]); h.flush();
  expect(late.dataset.jev).toBe("cover");
  expect(getComputedStyle(late).display).not.toBe("none");
});

test("settings inside paint publication gap preserve the existing hidden-item hold", async () => {
  // Given: a pre-paint hidden ad and a displayed item in a later content frame.
  const h = harness(); const ad = item("Suggested", 0);
  h.mutate(document.body, [ad]); h.flush();
  const visible = item("2h", 400); h.mutate(document.body, [visible]);
  h.frame(); h.task();
  // When: settings resolve after presentation but the paint-entry source stays false.
  await h.ready({ ...DEFAULT_SETTINGS, hideSuggested: false });
  h.flush();
  // Then: the unchanged reconciliation rule must hold the hidden in-view element.
  expect(ad.dataset.jev).toBe("hide");
  expect(ad.hasAttribute("data-jev-held")).toBe(true);
});

for (const top of [-400, 100]) {
  test(`existing hide survives a repeated hide verdict after paint at top=${top}`, async () => {
    // Given: hide was correctly applied before paint.
    const h = harness(); await h.ready(); const el = item("Sponsored", 0);
    h.mutate(document.body, [el]); h.flush();
    const descriptor = toDescriptor(0, el, SITES.x, extractSignals(el, SITES.x));
    const cache = freshCache(today(), providerKey(DEFAULT_SETTINGS));
    cache.entries[descriptor.key] = { ad: 1, suggested: 0 }; cache.order.push(descriptor.key);
    h.painted();
    Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ top }) });
    // When: a cache notification re-flushes the same key with want=hide.
    h.scanner.updateCache(cache); h.flush();
    // Then: placement may not reveal an already-collapsed item.
    expect(el.dataset.jev).toBe("hide");
    expect(getComputedStyle(el).display).toBe("none");
  });
}

test("currently visible item still downgrades a late in-view hide verdict to cover", () => {
  // Given
  const h = harness(); h.painted(); const el = item("Sponsored", 100);
  // When
  h.mutate(document.body, [el]); h.flush();
  // Then
  expect(el.dataset.jev).toBe("cover");
  expect(getComputedStyle(el).display).not.toBe("none");
});

test("nested parser records register each pending item once before the first flush", () => {
  // Given: a parent insertion and all its parser descendant insertions in one delivery.
  const h = harness(); const parent = document.createElement("main"); document.body.append(parent);
  const first = item(); const second = item(); parent.append(first, second);
  const child = first.firstElementChild;
  if (!child) throw new Error("missing fixture child");
  // When
  h.mutations([
    { target: document.body, addedNodes: [parent] },
    { target: parent, addedNodes: [first, second] },
    { target: first, addedNodes: [child] },
    { target: child, addedNodes: [...child.childNodes] }
  ]);
  // Then: both are ready for the same first delivery, without redundant registrations.
  expect(h.observations.filter(el => el === first)).toHaveLength(1);
  expect(h.observations.filter(el => el === second)).toHaveLength(1);
  h.flush();
  expect(first.dataset.jev).toBe("hide"); expect(second.dataset.jev).toBe("hide");
});

/** Restored by the shared afterEach, so a failing expectation cannot leak the stub. */
function captureWarnings() {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  cleanups.push(() => { console.warn = original; });
  return warnings;
}

test("repeated no-key answers warn exactly once per page load", async () => {
  // Given
  const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error: "no-key" }));
  const warnings = captureWarnings();
  // When: two separate batches each come back without a saved provider key.
  const first = item("2h"); h.mutate(document.body, [first]); h.flush(); await h.send();
  const second = item("3h"); h.mutate(document.body, [second]); h.flush(); await h.send();
  // Then: one warning for the page, and both unknown items still fail open.
  expect(h.calls).toHaveLength(2);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.slice(0, 2)).toEqual(["[jev-declutter]", "no-key"]);
  expect(first.hasAttribute("data-jev")).toBe(false);
  expect(second.hasAttribute("data-jev")).toBe(false);
});

for (const error of ["http-429", "network"]) {
  test(`${error} answers never emit the no-key warning`, async () => {
    // Given
    const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error }));
    const warnings = captureWarnings();
    // When
    const el = item("2h"); h.mutate(document.body, [el]); h.flush(); await h.send();
    // Then
    expect(h.calls).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(el.hasAttribute("data-jev")).toBe(false);
  });
}

test("no-key keeps deterministic hides while warning once", async () => {
  // Given
  const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error: "no-key" }));
  const warnings = captureWarnings();
  // When: a deterministic ad and an unknown item are discovered together.
  const ad = item("Sponsored"); const unknown = item("2h");
  h.mutate(document.body, [ad, unknown]); h.flush(); await h.send();
  // Then
  expect(ad.dataset.jev).toBe("hide");
  expect(unknown.hasAttribute("data-jev")).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.slice(0, 2)).toEqual(["[jev-declutter]", "no-key"]);
});

/** Same label, same skeleton: every element below shares one signalKey, as organic cards do. */
const group = (size: number, label: string) => Array.from({ length: size }, () => item(label, 2000));
const treated = (els: readonly Element[]) => els.filter((el) => el.hasAttribute("data-jev"));
const keyOf = (el: Element) => toDescriptor(0, el, SITES.x, extractSignals(el, SITES.x)).key;

/** One false-positive verdict for `key`, every other key organic. */
const poison = (key: string) => async (message: Message): Promise<ClassifyResult> => ({
  ok: true,
  scores: message.type === "classify"
    ? message.items.map((d) => ({ ad: d.key === key ? 0.95 : 0, suggested: null }))
    : []
});

/** Every skeleton on the page judged an ad, whatever its signalKey. */
const poisonAll = async (message: Message): Promise<ClassifyResult> => ({
  ok: true,
  scores: message.type === "classify" ? message.items.map(() => ({ ad: 0.95, suggested: null })) : []
});

const cachedVerdict = (key: string, ad: number) => {
  const c = freshCache(today(), providerKey(DEFAULT_SETTINGS));
  c.entries[key] = { ad, suggested: null }; c.order.push(key);
  return c;
};

test("one model answer keeps at most cap items of a shared key treated", async () => {
  // Given: a feed where far more items than the cap share one organic skeleton.
  const h = harness(); await h.ready();
  const els = group(100, "2h");
  h.response(poison(keyOf(els[0] as Element)));
  // When: a single false-positive verdict comes back for that one key.
  h.mutate(document.body, els); h.flush();
  await h.send(); h.flush();
  // Then: a quarter of the page is the bound, so 75% of the feed survives.
  const cap = modelGroupCap(els.length);
  expect(cap).toBe(25);
  expect(h.calls).toHaveLength(1);
  expect(treated(els)).toHaveLength(cap);
  expect(treated(els)).toEqual(els.slice(0, cap));
  expect(els.slice(cap).some((el) => el.hasAttribute("data-jev-held"))).toBe(false);
  // And: the signature is recorded once, so the options page can name it for reset.
  expect(h.overCapped.at(-1)).toEqual([keyOf(els[0] as Element)]);
});

test("deterministic verdicts on the same page are neither counted nor capped", async () => {
  // Given: a capped model group and a larger deterministic group on one page.
  const h = harness(); await h.ready();
  const unknown = group(60, "2h");
  const ads = group(60, "Sponsored");
  h.response(poison(keyOf(unknown[0] as Element)));
  // When
  h.mutate(document.body, [...unknown, ...ads]); h.flush();
  await h.send(); h.flush();
  // Then: per-item evidence stays unbounded while the shared verdict is bounded.
  expect(treated(ads)).toHaveLength(60);
  expect(ads.every((el) => el.dataset.jev === "hide")).toBe(true);
  // 120 items observed -> cap 30, and deterministic items are part of the denominator only.
  expect(treated(unknown)).toHaveLength(modelGroupCap(120));
  expect(h.overCapped.flat()).toEqual([keyOf(unknown[0] as Element)]);
});

test("a cache hit obeys the same cap without any request", async () => {
  // Given: yesterday's poisoned verdict for the skeleton most items share.
  const h = harness();
  const els = group(100, "2h");
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(els[0] as Element), 0.95));
  // When
  h.mutate(document.body, els); h.flush(); await h.send();
  // Then
  expect(h.calls).toHaveLength(0);
  expect(treated(els)).toHaveLength(modelGroupCap(els.length));
  expect(h.overCapped.flat()).toEqual([keyOf(els[0] as Element)]);
});

test("a model group at the cap is treated in full and records nothing", async () => {
  // Given: exactly as many items of one key as the floor allows, on a small page.
  const h = harness(); await h.ready();
  const els = group(MIN_MODEL_GROUP, "2h");
  h.response(poison(keyOf(els[0] as Element)));
  // When
  h.mutate(document.body, els); h.flush();
  await h.send(); h.flush();
  // Then: at or below the cap nothing changes, including the diagnostics record.
  expect(modelGroupCap(els.length)).toBe(MIN_MODEL_GROUP);
  expect(treated(els)).toHaveLength(MIN_MODEL_GROUP);
  expect(els.every((el) => el.dataset.jev === "hide")).toBe(true);
  expect(h.overCapped).toEqual([]);
});

test("an item already treated by a model verdict stays treated when the group goes over", async () => {
  // Given: the cap is reached, then more items of the same key arrive.
  const h = harness(); await h.ready(); h.painted();
  const first = group(MIN_MODEL_GROUP, "2h");
  const key = keyOf(first[0] as Element);
  h.response(poison(key));
  h.mutate(document.body, first); h.flush(); await h.send(); h.flush();
  const before = first.map((el) => el.getAttribute("data-jev"));
  // When: more of the same skeleton arrive and a cache notification re-flushes every item.
  const late = group(3, "2h");
  h.mutate(document.body, late);
  h.scanner.updateCache(cachedVerdict(key, 0.95)); h.flush();
  // Then: no treated item is revealed and no capped one is treated or held.
  expect(before).toEqual(first.map(() => "hide"));
  expect(first.map((el) => el.getAttribute("data-jev"))).toEqual(before);
  expect(treated(late)).toHaveLength(0);
  expect(late.some((el) => el.hasAttribute("data-jev-held"))).toBe(false);
});

test("ten real-ad cells of one key recycled four times all stay treated", async () => {
  // Given: the gate review's recycle control. X recycles cells; the page never holds more
  // than ten items of this key, so the verdict must never be capped.
  const h = harness(); await h.ready();
  const cells = group(10, "2h");
  const adKey = keyOf(cells[0] as Element);
  h.response(poison(adKey));
  h.mutate(document.body, cells); h.flush(); await h.send(); h.flush();
  expect(treated(cells)).toHaveLength(10);
  // When: each cell is recycled away from the ad skeleton and back, four times over.
  for (let round = 0; round < 4; round++) {
    for (const el of cells) {
      const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
    }
    await h.send(); h.flush();
    for (const el of cells) {
      el.querySelector("img")?.remove(); h.mutate(el, []); h.flush();
    }
  }
  // Then: the budget is spent by distinct items, not by treatment events.
  expect(treated(cells)).toHaveLength(10);
  expect(cells.every((el) => el.dataset.jev === "hide")).toBe(true);
  expect(h.overCapped).toEqual([]);
});

test("re-processing the same element under the same key never charges twice", async () => {
  // Given: a page whose cap is the floor, filled exactly, plus one refused item.
  const h = harness();
  const els = group(MIN_MODEL_GROUP + 1, "2h");
  const key = keyOf(els[0] as Element);
  const c = cachedVerdict(key, 0.95);
  await h.ready(DEFAULT_SETTINGS, c);
  h.mutate(document.body, els); h.flush();
  expect(treated(els)).toHaveLength(MIN_MODEL_GROUP);
  // When: every treated item is re-flushed repeatedly through cache notifications.
  for (let i = 0; i < 3; i++) { h.scanner.updateCache(c); h.flush(); }
  // Then: the charge count is still exactly the number of treated items, which one
  // release per element proves - all fifteen free their slot and fifteen fresh items fit.
  for (const el of els.slice(0, MIN_MODEL_GROUP)) el.remove();
  const probe = item("99h");
  h.mutate(document.body, [probe]); h.flush(); await h.send();
  const fresh = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, fresh); h.flush();
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP);
});

for (const [size, cap] of [[100, 25], [20, MIN_MODEL_GROUP]] as const) {
  test(`the cap follows the observed item count: ${size} items -> ${cap}`, async () => {
    // Given
    const h = harness();
    const els = group(size, "2h");
    await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(els[0] as Element), 0.95));
    // When
    h.mutate(document.body, els); h.flush();
    // Then: a quarter of the page, never fewer than the floor.
    expect(modelGroupCap(size)).toBe(cap);
    expect(treated(els)).toHaveLength(cap);
    expect(h.scanner.qa.observedItems).toBe(size);
  });
}

test("disconnecting a treated item frees its charge while a held item keeps it", async () => {
  // Given: the cap filled at the floor by one key, with two further items refused.
  const h = harness();
  const els = group(MIN_MODEL_GROUP + 2, "2h");
  const key = keyOf(els[0] as Element);
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(key, 0.95));
  h.mutate(document.body, els); h.flush();
  const [first, second] = els;
  const refused = els.slice(MIN_MODEL_GROUP);
  if (!first || !second) throw new Error("missing fixture");
  expect(treated(refused)).toHaveLength(0);
  // When: one treated item leaves the DOM and the next batch sweep notices.
  first.remove();
  const probe = item("99h");
  h.mutate(document.body, [probe]); h.flush(); await h.send();
  h.mutate(refused[0] as Element); h.flush();
  // Then: the freed slot is taken by one previously refused item.
  expect((refused[0] as Element).getAttribute("data-jev")).toBe("hide");
  // When: a treated item is instead recycled inside the viewport after paint, so it is held.
  h.painted();
  const img = document.createElement("img"); second.append(img);
  h.mutate(second, [img]); h.flush();
  expect(second.getAttribute("data-jev")).toBe("hide");
  expect(second.hasAttribute("data-jev-held")).toBe(true);
  h.mutate(refused[1] as Element); h.flush();
  // Then: a still-hidden item keeps its charge, so nothing else of that key is treated.
  expect((refused[1] as Element).hasAttribute("data-jev")).toBe(false);
});

test("a fully cached page view frees the slots of items it never re-requests", async () => {
  // Given: the cap filled at the floor from the daily cache, so no classify batch ever runs.
  const h = harness();
  const cells = group(MIN_MODEL_GROUP, "2h");
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(cells[0] as Element), 0.95));
  h.mutate(document.body, cells); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  // When: every treated cell leaves the DOM and fifteen fresh ones of that key arrive.
  for (const el of cells) el.remove();
  const fresh = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, fresh); h.flush();
  // Then: the slots a removed treatment held are free, with no batch to sweep them.
  expect(h.calls).toHaveLength(0);
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP);
});

test("a held then removed cell frees the slot of the key that paid for it", async () => {
  // Given: the cap filled at the floor by one key, from the cache.
  const h = harness();
  const cells = group(MIN_MODEL_GROUP, "2h");
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(cells[0] as Element), 0.95));
  h.mutate(document.body, cells); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  // When: eight treated cells are recycled inside the viewport after paint, so they are held
  // under the key that hid them, and X then drops them.
  h.painted();
  const held = cells.slice(0, 8);
  for (const el of held) {
    Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 100, width: 100, height: 100 }) });
    const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
  }
  expect(held.every((el) => el.hasAttribute("data-jev-held") && el.dataset.jev === "hide")).toBe(true);
  for (const el of held) el.remove();
  // Then: seven live treatments remain of a floor of fifteen, so eight fresh items of that key
  // fit. Releasing under the recycled-TO key instead would leave none of them treated.
  const fresh = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, fresh); h.flush();
  expect(h.calls).toHaveLength(0);
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP - 7);
});

test("navigation clears the charges and the observed item count", async () => {
  // Given: the cap filled at the floor, one item refused. The verdict arrives by answer, since
  // a signalKey carries path_kind and so does not survive the navigation below.
  const h = harness(); await h.ready();
  h.response(poisonAll);
  const els = group(MIN_MODEL_GROUP + 1, "2h");
  h.mutate(document.body, els); h.flush(); await h.send(); h.flush();
  const refused = els[MIN_MODEL_GROUP];
  if (!refused) throw new Error("missing fixture");
  expect(treated(els)).toHaveLength(MIN_MODEL_GROUP);
  expect(refused.hasAttribute("data-jev")).toBe(false);
  expect(h.overCapped).toHaveLength(1);
  // When: most of the treated items are gone and the SPA navigates.
  for (const el of els.slice(0, 10)) el.remove();
  window.history.pushState(null, "", "/explore");
  h.mutate(document.body); h.flush(); await h.send(); h.flush();
  // Then: the page view starts over - six survivors against a floor of fifteen, so every
  // survivor is treated. Charges left over from the old page view would still refuse them.
  expect(h.scanner.qa.observedItems).toBe(MIN_MODEL_GROUP + 1 - 10);
  expect(treated(els.slice(10))).toHaveLength(MIN_MODEL_GROUP + 1 - 10);
  expect(refused.getAttribute("data-jev")).toBe("hide");
  expect(h.overCapped).toHaveLength(1);
});

test("a held item leaves the verdict it did not apply a full budget", async () => {
  // Given: the cap filled at the floor below the fold, with every skeleton judged an ad.
  const h = harness(); await h.ready();
  h.response(poisonAll);
  const cells = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, cells); h.flush(); await h.send(); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  // When: all fifteen are scrolled into view after paint and recycled to a second skeleton that
  // the same verdict also wants hidden - so all fifteen are held, still hidden (D6).
  h.painted();
  for (const el of cells) {
    Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 100, width: 100, height: 100 }) });
    const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
  }
  await h.send(); h.flush();
  expect(cells.filter((el) => el.hasAttribute("data-jev-held"))).toHaveLength(MIN_MODEL_GROUP);
  expect(cells.every((el) => el.dataset.jev === "hide")).toBe(true);
  // Then: the recycled-to skeleton paid for none of those holds, so its own items below the
  // fold all fit its budget. Charging the held item would leave them all untreated.
  const fresh = Array.from({ length: MIN_MODEL_GROUP }, () => {
    const el = item("2h", 2000); el.append(document.createElement("img")); return el;
  });
  h.mutate(document.body, fresh); h.flush(); await h.send(); h.flush();
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP);
});

test("a cache re-notification at the cap never withdraws an existing hide", async () => {
  // Given: the cap exactly filled below the fold, where no D6 hold can mask a withdrawal.
  const h = harness();
  const cells = group(MIN_MODEL_GROUP, "2h");
  const c = cachedVerdict(keyOf(cells[0] as Element), 0.95);
  await h.ready(DEFAULT_SETTINGS, c);
  h.mutate(document.body, cells); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  // When: the same verdict is broadcast again while its key sits exactly at the cap.
  h.scanner.updateCache(c); h.flush();
  // Then: an item this verdict already holds treated keeps its treatment and its slot - a
  // treatment is never withdrawn, and nothing had to be held to achieve that.
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  expect(cells.every((el) => el.dataset.jev === "hide")).toBe(true);
  expect(cells.some((el) => el.hasAttribute("data-jev-held"))).toBe(false);
});

test("a key whose live group never exceeds the cap is never recorded", async () => {
  // Given: ten items of one key on a sixty-item page, so the floor is never reached.
  const h = harness(); await h.ready();
  const mine = group(10, "2h");
  const others = group(50, "Sponsored");
  h.response(poison(keyOf(mine[0] as Element)));
  h.mutate(document.body, [...mine, ...others]); h.flush(); await h.send(); h.flush();
  // When: those ten are recycled away and back twice - thirty treatment events in all.
  for (let round = 0; round < 4; round++) {
    for (const el of mine) {
      const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
    }
    await h.send(); h.flush();
    for (const el of mine) {
      el.querySelector("img")?.remove(); h.mutate(el, []); h.flush();
    }
  }
  // Then: over cap is judged on live items, so a correct verdict is never reported
  // and the maintainer is never told to clear a good cache entry.
  expect(treated(mine)).toHaveLength(10);
  expect(treated(others)).toHaveLength(50);
  expect(h.overCapped).toEqual([]);
});

// --- todo 29: user answers on model-blurred items ---------------------------------------------

const unknownAt = (top: number) => item("2h", top);

function moduleItem(top = 0) {
  const el = document.createElement("div");
  el.setAttribute("aria-label", "Timeline: Trending now");
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 }) });
  document.body.append(el);
  return el;
}

const overrideMap = (key: string, decision: OverrideDecision): OverrideMap => ({ entries: { [key]: { decision, at: 1 } } });

test("a keep answer short-circuits the model: no request, no treatment, no prompt", async () => {
  // Given: the user has already said this skeleton is not an ad.
  const h = harness();
  const el = unknownAt(0);
  await h.ready(DEFAULT_SETTINGS, undefined, overrideMap(keyOf(el), "keep"));
  h.painted();
  // When
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  // Then: answering costs nothing afterwards - the key never reaches the provider again.
  expect(h.calls).toHaveLength(0);
  expect(el.hasAttribute("data-jev")).toBe(false);
  expect(h.prompts.size).toBe(0);
});

test("a confirmed answer treats the item from the user's own verdict, without a request or a prompt", async () => {
  const h = harness();
  const below = unknownAt(2000);
  const inView = unknownAt(0);
  await h.ready(DEFAULT_SETTINGS, undefined, overrideMap(keyOf(below), "confirmed"));
  h.painted();
  // When
  h.mutate(document.body, [below, inView]); h.flush(); await h.send(); h.flush();
  // Then: the user's yes is per-item evidence like a deterministic signal - placement still rules.
  expect(h.calls).toHaveLength(0);
  expect(below.dataset.jev).toBe("hide");
  expect(inView.dataset.jev).toBe("cover");
  expect(h.prompts.size).toBe(0);
});

test("an answer never overrides a deterministic verdict and a deterministic item never gets a prompt", async () => {
  const h = harness();
  const inView = item("Sponsored", 0);
  const below = item("Sponsored", 2000);
  await h.ready(DEFAULT_SETTINGS, undefined, overrideMap(keyOf(inView), "keep"));
  h.painted();
  // When
  h.mutate(document.body, [inView, below]); h.flush();
  // Then: deterministic > user override, and no prompt is offered for it.
  expect(inView.dataset.jev).toBe("cover");
  expect(below.dataset.jev).toBe("hide");
  expect(h.prompts.size).toBe(0);
});

test("the prompt appears only on a model blur, never on a hide, a deterministic item or a module", async () => {
  // Given
  const h = harness(); await h.ready(); h.painted();
  const modelInView = unknownAt(0);
  const modelBelow = unknownAt(2000);
  const deterministicInView = item("Sponsored", 0);
  const mod = moduleItem(0);
  const key = keyOf(modelInView);
  h.response(poison(key));
  // When
  h.mutate(document.body, [modelInView, modelBelow, deterministicInView, mod]); h.flush();
  await h.send(); h.flush();
  // Then
  expect(modelInView.dataset.jev).toBe("blur");
  expect(modelBelow.dataset.jev).toBe("hide");
  expect(deterministicInView.dataset.jev).toBe("cover");
  expect(mod.dataset.jev).toBe("cover");
  expect([...h.prompts.keys()]).toEqual([modelInView]);
  expect(h.prompt(modelInView)).toBe(key);
});

test("answering no unblurs the item, releases every same-key item and sends nothing", async () => {
  // Given: three items of one model-judged skeleton, two in view and one below the fold.
  const h = harness(); await h.ready(); h.painted();
  const inView = unknownAt(0);
  const second = unknownAt(0);
  const filler = item("", 2000);
  const below = unknownAt(2000);
  const localAd = item("Sponsored", 0);
  const key = keyOf(inView);
  h.response(poison(key));
  h.mutate(document.body, [inView, second, filler, below, localAd]); h.flush();
  await h.send(); h.flush();
  expect([inView.dataset.jev, second.dataset.jev, below.dataset.jev]).toEqual(["blur", "blur", "hide"]);
  const before = h.calls.length;
  // When: the user answers "not an ad".
  h.answer(key, "keep");
  // Then: every same-key item on the page is released, the answer is persisted, nothing is sent.
  expect(inView.hasAttribute("data-jev")).toBe(false);
  expect(second.hasAttribute("data-jev")).toBe(false);
  expect(below.hasAttribute("data-jev")).toBe(false);
  expect(localAd.dataset.jev).toBe("cover");
  expect(h.saved).toEqual([{ key, decision: "keep" }]);
  expect(h.calls).toHaveLength(before);
  expect(h.prompts.size).toBe(0);
});

test("answering yes keeps the treatment, persists the confirmation and drops the prompt", async () => {
  // Given
  const h = harness(); await h.ready(); h.painted();
  const inView = unknownAt(0);
  const below = unknownAt(2000);
  const key = keyOf(inView);
  h.response(poison(key));
  h.mutate(document.body, [inView, below]); h.flush(); await h.send(); h.flush();
  expect(h.prompt(inView)).toBe(key);
  const before = h.calls.length;
  // When
  h.answer(key, "confirmed");
  // Then
  expect(inView.dataset.jev).toBe("cover");
  expect(below.dataset.jev).toBe("hide");
  expect(h.saved).toEqual([{ key, decision: "confirmed" }]);
  expect(h.calls).toHaveLength(before);
  expect(h.prompts.size).toBe(0);
});

test("a reload applies the stored answer ahead of the cached model verdict", async () => {
  // Given: yesterday's answer and today's cached model verdict for the same key.
  const h = harness();
  const el = unknownAt(0);
  const key = keyOf(el);
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(key, 0.95), overrideMap(key, "keep"));
  h.painted();
  // When
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  // Then: deterministic > user override > cache/model, and no prompt reappears.
  expect(el.hasAttribute("data-jev")).toBe(false);
  expect(h.calls).toHaveLength(0);
  expect(h.prompts.size).toBe(0);
});

test("a keep answer returns every cap slot the model verdict was holding", async () => {
  // Given: one poisoned verdict holding the model group cap on a hundred-item page.
  const h = harness(); await h.ready();
  const els = group(100, "2h");
  const key = keyOf(els[0] as Element);
  h.response(poison(key));
  h.mutate(document.body, els); h.flush(); await h.send(); h.flush();
  expect(treated(els)).toHaveLength(modelGroupCap(els.length));
  expect(h.overCapped.at(-1)).toEqual([key]);
  // When
  h.answer(key, "keep");
  // Then: nothing of that key is treated and no slot stays spent.
  expect(treated(els)).toHaveLength(0);
  expect(h.saved).toEqual([{ key, decision: "keep" }]);
});

test("a detached item loses its prompt in the scanner's own sweep", async () => {
  // Given: a model blur with its prompt up.
  const h = harness(); await h.ready(); h.painted();
  const el = unknownAt(0);
  const key = keyOf(el);
  h.response(poison(key));
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  expect(h.prompt(el)).toBe(key);
  // When: another item queues a request, the page drops the prompted one ("not interested", a
  // timeline re-render) and the next batch sweeps its state - with no flush in between, so the
  // sweep is the only thing that can drop the prompt.
  h.mutate(document.body, [item("3h", 2000)]); h.flush();
  el.remove();
  await h.send();
  // Then: no pill is left behind to answer for a post that is no longer there.
  expect(h.prompts.size).toBe(0);
});

test("a flush drops the prompt of an item the page detached without telling the scanner", async () => {
  // Given
  const h = harness(); await h.ready(); h.painted();
  const el = unknownAt(0);
  h.response(poison(keyOf(el)));
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  expect(h.prompts.size).toBe(1);
  // When: the item is gone and any unrelated item re-flushes the scanner.
  el.remove();
  h.mutate(document.body, [item("Sponsored", 2000)]); h.flush();
  // Then
  expect(h.prompts.size).toBe(0);
});

test("an SPA navigation re-reads the stored answers, so a cleared answer applies again", async () => {
  // Given: an answered key, so the cached model verdict is held back.
  const h = harness();
  const el = unknownAt(2000);
  const key = keyOf(el);
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(key, 0.95), overrideMap(key, "keep"));
  h.mutate(document.body, [el]); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false);
  // When: the user clears that answer on the options page and the SPA navigates.
  h.setOverrides(undefined);
  window.history.pushState(null, "", "/home/latest");
  h.mutate(document.body); h.flush();
  await h.overridesRead();
  h.flush();
  // Then: the cleared answer stops applying, exactly as the options page says it will.
  expect(el.dataset.jev).toBe("hide");
});

test("DOMContentLoaded does not enqueue already processed initial items again", async () => {
  // Given
  const h = harness(); await h.ready(); const el = item();
  h.mutate(document.body, [el]); h.flush(); const before = h.observations.length;
  // When
  document.dispatchEvent(new Event("DOMContentLoaded"));
  // Then
  expect(h.observations).toHaveLength(before);
});
