import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startScanner, type ScanHost, type Mutation } from "../src/scan";
import type { OverrideDecision, OverrideMap } from "../src/overrides";
import { deterministic } from "../src/rules";
import { SITES, type SiteConfig } from "../src/sites";
import { DEFAULT_SETTINGS } from "../src/storage";
import { freshCache, MAX_ITEMS, MIN_MODEL_GROUP, modelGroupCap, providerKey } from "../src/cache";
import { COLLAPSE_CSS, today } from "../src/decide";
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
  let resize: (() => void) | undefined;
  const readingWatchers: { callback: () => void; targets: Set<Element> }[] = [];
  const scrolledBy: number[] = [];
  let scrollY = 0;
  let readingCandidates: (Element | null)[] = [];
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
    resize: (cb) => {
      if (resize) {
        const watcher = { callback: cb, targets: new Set<Element>() };
        readingWatchers.push(watcher);
        return { observe: (el) => { watcher.targets.add(el); }, unobserve: (el) => { watcher.targets.delete(el); }, disconnect: () => watcher.targets.clear() };
      }
      resize = cb;
      return { observe: (el) => { targets.add(el); observations.push(el); }, unobserve: (el) => { targets.delete(el); }, disconnect: () => targets.clear() };
    },
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
      revalidate: () => { for (const el of Array.from(prompts.keys())) if (!el.isConnected) prompts.delete(el); },
      clear: () => { prompts.clear(); }
    },
    elementAt: () => readingCandidates.shift() ?? null,
    scrollY: () => scrollY,
    scrollBy: (dy) => { scrolledBy.push(dy); scrollY += dy; }
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
    flush: () => resize?.(),
    readingWatchers, scrolledBy,
    readingCandidates: (...elements: (Element | null)[]) => { readingCandidates = elements; },
    userScroll: (y: number) => { scrollY = y; },
    deliverReadingResize: () => { for (const watcher of readingWatchers) if (watcher.targets.size > 0) watcher.callback(); },
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

for (const inFrame of [false, true]) {
  for (const [painted, top] of [[false, 0], [true, 0], [true, 2000]] as const) {
    test(`a mutation hides a deterministic ad synchronously inFrame=${inFrame} painted=${painted} top=${top}`, () => {
      const h = harness();
      if (painted) h.painted();
      if (inFrame) h.frame();
      const el = item("Sponsored", top);
      h.mutate(document.body, [el]);
      expect(el.getAttribute("data-jev")).toBe("hide");
      expect(h.scanner.qa.applyPaths.get(el)).toBe("mutation");
    });
  }
}

test("default settings hide ads before storage and preserve treatment after settings resolve", async () => {
  const h = harness(); const previous = item("", 2000); const el = item("Sponsored", 2100);
  h.mutate(document.body, [previous, el]); h.flush();
  expect(el.dataset.jev).toBe("hide");
  h.painted();
  await h.ready({ ...DEFAULT_SETTINGS, hideSuggested: false }); h.flush();
  expect(el.dataset.jev).toBe("hide");
  expect(el.hasAttribute("data-jev-held")).toBe(false);
  await h.send();
  expect(h.calls).toHaveLength(0);
});

test("module keep settings loaded before insertion never treat the module", async () => {
  const h = harness(); await h.ready({ ...DEFAULT_SETTINGS, hideSuggested: false });
  const module = document.createElement("aside");
  module.setAttribute("aria-label", "Subscribe to Premium");
  Object.defineProperty(module, "getBoundingClientRect", { value: () => ({ top: 100, bottom: 200, width: 100, height: 100 }) });
  const treatments: string[] = [];
  const setAttribute = module.setAttribute.bind(module);
  module.setAttribute = (name, value) => {
    if (name === "data-jev") treatments.push(value);
    setAttribute(name, value);
  };
  document.body.append(module);
  h.mutate(document.body, [module]); h.flush(); h.frame(); h.task(); h.flush();
  expect(module.hasAttribute("data-jev")).toBe(false);
  expect(treatments).toEqual([]);
});

test("late module keep settings hold the visible module and release the below viewport module", async () => {
  const h = harness();
  const modules = [100, 2000].map((top) => {
    const previous = item("", top - 100);
    const module = document.createElement("aside");
    module.setAttribute("aria-label", "Subscribe to Premium");
    Object.defineProperty(module, "getBoundingClientRect", { value: () => ({ top, bottom: top + 100, width: 100, height: 100 }) });
    previous.after(module);
    return module;
  });
  h.mutate(document.body, modules); h.flush();
  expect(modules.map((el) => el.getAttribute("data-jev"))).toEqual(["hide", "hide"]);
  h.painted();
  await h.ready({ ...DEFAULT_SETTINGS, hideSuggested: false }); h.flush();
  expect(modules.map((el) => [el.getAttribute("data-jev"), el.hasAttribute("data-jev-held")])).toEqual([
    ["hide", true], [null, false]
  ]);
});

test("unknown waits for cache then model response blurs on screen", async () => {
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

test("only sites that opt in collapse hidden items to a zero box instead of removing them from layout", () => {
  const css = () => document.getElementById("jev-declutter")?.textContent ?? "";
  harness(SITES.instagram);
  expect(css()).toContain(COLLAPSE_CSS);
  document.getElementById("jev-declutter")?.remove();
  harness(SITES.x);
  expect(css()).not.toContain(COLLAPSE_CSS);
});

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

test("seeded positive cache treats every real fixture alias without sending requests", async () => {
  const cfg = SITES.youtube;
  const h = harness(cfg);
  const items = fixtureItems("youtube-en.html", cfg);
  const descriptors = items.map((el, n) => toDescriptor(n, el, cfg, extractSignals(el, cfg)));
  const key = descriptors[0]?.key;
  if (!key) throw new Error("missing fixture key");
  const aliases = items.filter((_, n) => descriptors[n]?.key === key);
  expect(aliases.map((el) => el.getAttribute("data-qa-id"))).toEqual(["init-0", "init-4", "init-6", "init-8", "init-10"]);
  const cache = freshCache(today(), providerKey(DEFAULT_SETTINGS));
  for (const descriptor of descriptors) {
    cache.entries[descriptor.key] = { ad: 0, suggested: 0 };
  }
  cache.entries[key] = { ad: 0.95, suggested: null };
  cache.order = Object.keys(cache.entries);
  await h.ready(DEFAULT_SETTINGS, cache);
  h.mutate(document.body, items); h.flush(); await h.send(); h.flush();
  expect(aliases.map((el) => el.getAttribute("data-jev"))).toEqual(["hide", "hide", "hide", "hide", "hide"]);
  expect(h.calls).toHaveLength(0);
});

test("late modules in and below the viewport are both hidden after child insertion", async () => {
  const h = harness(SITES.youtube); await h.ready();
  const modules = [100, 2000].map((top) => {
    const module = document.createElement("ytd-rich-section-renderer");
    Object.defineProperty(module, "getBoundingClientRect", { value: () => ({ top, bottom: top + 120, width: 100, height: 120 }) });
    document.body.append(module);
    return module;
  });
  h.mutate(document.body, modules); h.flush(); h.painted();
  expect(modules.map((el) => el.getAttribute("data-jev"))).toEqual([null, null]);
  h.mutations(modules.map((module) => {
    const child = document.createElement("ytd-rich-shelf-renderer");
    child.setAttribute("is-shorts", "");
    module.append(child);
    return { target: module, addedNodes: [child] };
  }));
  h.flush();
  expect(modules.map((el) => el.getAttribute("data-jev"))).toEqual(["hide", "hide"]);
});

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

test("module recognized after child insertion is hidden", () => {
  const h = harness(); h.painted();
  const aside = document.createElement("aside"); aside.setAttribute("aria-label", "Subscribe to Premium"); document.body.append(aside);
  h.mutate(aside, [document.createElement("span")]); h.flush();
  expect(aside.dataset.jev).toBe("hide");
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

test("a hide stays hidden when a later cache verdict arrives below viewport", async () => {
  const h = harness(); await h.ready(); h.painted(); const el = item("Sponsored", 0);
  h.mutate(document.body, [el]); h.flush();
  Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ top: 2000 }) });
  h.mutate(el); h.flush();
  expect(el.dataset.jev).toBe("hide");
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
  expect(section.dataset.jev).toBe("hide");
});

test("content frame downgrades a late visible ad while paint entries remain empty", () => {
  const h = harness(); const visible = item("2h", 0);
  h.mutate(document.body, [visible]);
  h.frame(); h.task();
  const ad = item("Sponsored", 0);
  h.mutate(document.body, [ad]); h.flush();
  expect(ad.dataset.jev).toBe("hide");
  expect(h.scanner.qa.applyPaths.get(ad)).toBe("mutation");
});

test("blank frame does not count content connected only after that frame", () => {
  const h = harness(); h.frame();
  const visible = item("2h", 0);
  h.mutate(document.body, [visible]);
  h.task();
  const ad = item("Sponsored", 0);
  h.mutate(document.body, [ad]); h.flush();
  expect(ad.dataset.jev).toBe("hide");
});

test("item parked inside a display:none ancestor never witnesses a painted frame", () => {
  const h = harness();
  const hidden = document.createElement("section");
  hidden.style.display = "none";
  document.body.append(hidden);
  const parked = item("2h", 0);
  hidden.append(parked);
  h.mutate(document.body, [hidden]);
  expect(getComputedStyle(parked).display).toBe("block");
  expect(parked.checkVisibility()).toBe(false);
  h.frame(); h.task();
  h.frame(); h.task();
  hidden.style.display = "";
  const ad = item("Sponsored", 0);
  h.mutate(document.body, [ad]); h.flush();
  expect(ad.dataset.jev).toBe("hide");
  expect(getComputedStyle(ad).display).toBe("none");
  h.frame(); h.task();
  const late = item("Sponsored", 0);
  h.mutate(document.body, [late]); h.flush();
  expect(late.dataset.jev).toBe("hide");
  expect(getComputedStyle(late).display).toBe("none");
});

test("settings inside paint publication gap preserve the existing hidden-item hold", async () => {
  const h = harness(); const ad = item("Suggested", 0);
  h.mutate(document.body, [ad]); h.flush();
  const visible = item("2h", 400); h.mutate(document.body, [visible]);
  h.frame(); h.task();
  await h.ready({ ...DEFAULT_SETTINGS, hideSuggested: false });
  h.flush();
  expect(ad.dataset.jev).toBe("hide");
  expect(ad.hasAttribute("data-jev-held")).toBe(true);
});

for (const top of [-400, 100]) {
  test(`existing hide survives a repeated hide verdict after paint at top=${top}`, async () => {
    const h = harness(); await h.ready(); const el = item("Sponsored", 0);
    h.mutate(document.body, [el]); h.flush();
    const descriptor = toDescriptor(0, el, SITES.x, extractSignals(el, SITES.x));
    const cache = freshCache(today(), providerKey(DEFAULT_SETTINGS));
    cache.entries[descriptor.key] = { ad: 1, suggested: 0 }; cache.order.push(descriptor.key);
    h.painted();
    Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ top }) });
    h.scanner.updateCache(cache); h.flush();
    expect(el.dataset.jev).toBe("hide");
    expect(getComputedStyle(el).display).toBe("none");
  });
}

test("a late in-view hide verdict removes the visible item", () => {
  const h = harness(); h.painted(); const el = item("Sponsored", 100);
  h.mutate(document.body, [el]); h.flush();
  expect(el.dataset.jev).toBe("hide");
  expect(getComputedStyle(el).display).toBe("none");
});

test("nested parser records register each pending item once before the first flush", () => {
  const h = harness(); const parent = document.createElement("main"); document.body.append(parent);
  const first = item(); const second = item(); parent.append(first, second);
  const child = first.firstElementChild;
  if (!child) throw new Error("missing fixture child");
  h.mutations([
    { target: document.body, addedNodes: [parent] },
    { target: parent, addedNodes: [first, second] },
    { target: first, addedNodes: [child] },
    { target: child, addedNodes: [...child.childNodes] }
  ]);
  expect(h.observations.filter(el => el === first)).toHaveLength(1);
  expect(h.observations.filter(el => el === second)).toHaveLength(1);
  h.flush();
  expect(first.dataset.jev).toBe("hide"); expect(second.dataset.jev).toBe("hide");
});

function captureWarnings() {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  cleanups.push(() => { console.warn = original; });
  return warnings;
}

test("repeated no-key answers warn exactly once per page load", async () => {
  const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error: "no-key" }));
  const warnings = captureWarnings();
  const first = item("2h"); h.mutate(document.body, [first]); h.flush(); await h.send();
  const second = item("3h"); h.mutate(document.body, [second]); h.flush(); await h.send();
  expect(h.calls).toHaveLength(2);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.slice(0, 2)).toEqual(["[jev-declutter]", "no-key"]);
  expect(first.hasAttribute("data-jev")).toBe(false);
  expect(second.hasAttribute("data-jev")).toBe(false);
});

for (const error of ["http-429", "network"]) {
  test(`${error} answers never emit the no-key warning`, async () => {
    const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error }));
    const warnings = captureWarnings();
    const el = item("2h"); h.mutate(document.body, [el]); h.flush(); await h.send();
    expect(h.calls).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    expect(el.hasAttribute("data-jev")).toBe(false);
  });
}

test("no-key keeps deterministic hides while warning once", async () => {
  const h = harness(); await h.ready(); h.response(async () => ({ ok: false, error: "no-key" }));
  const warnings = captureWarnings();
  const ad = item("Sponsored"); const unknown = item("2h");
  h.mutate(document.body, [ad, unknown]); h.flush(); await h.send();
  expect(ad.dataset.jev).toBe("hide");
  expect(unknown.hasAttribute("data-jev")).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.slice(0, 2)).toEqual(["[jev-declutter]", "no-key"]);
});

const group = (size: number, label: string) => Array.from({ length: size }, () => item(label, 2000));
const treated = (els: readonly Element[]) => els.filter((el) => el.hasAttribute("data-jev"));
const keyOf = (el: Element) => toDescriptor(0, el, SITES.x, extractSignals(el, SITES.x)).key;

const poison = (key: string) => async (message: Message): Promise<ClassifyResult> => ({
  ok: true,
  scores: message.type === "classify"
    ? message.items.map((d) => ({ ad: d.key === key ? 0.95 : 0, suggested: null }))
    : []
});

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
  const h = harness(); await h.ready();
  const els = group(100, "2h");
  h.response(poison(keyOf(els[0] as Element)));
  h.mutate(document.body, els); h.flush();
  await h.send(); h.flush();
  const cap = modelGroupCap(els.length);
  expect(cap).toBe(25);
  expect(h.calls).toHaveLength(1);
  expect(treated(els)).toHaveLength(cap);
  expect(treated(els)).toEqual(els.slice(0, cap));
  expect(els.slice(cap).some((el) => el.hasAttribute("data-jev-held"))).toBe(false);
  expect(h.overCapped.at(-1)).toEqual([keyOf(els[0] as Element)]);
});

test("deterministic verdicts on the same page are neither counted nor capped", async () => {
  const h = harness(); await h.ready();
  const unknown = group(60, "2h");
  const ads = group(60, "Sponsored");
  h.response(poison(keyOf(unknown[0] as Element)));
  h.mutate(document.body, [...unknown, ...ads]); h.flush();
  await h.send(); h.flush();
  expect(treated(ads)).toHaveLength(60);
  expect(ads.every((el) => el.dataset.jev === "hide")).toBe(true);
  expect(treated(unknown)).toHaveLength(modelGroupCap(120));
  expect(h.overCapped.flat()).toEqual([keyOf(unknown[0] as Element)]);
});

test("a cache hit obeys the same cap without any request", async () => {
  const h = harness();
  const els = group(100, "2h");
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(els[0] as Element), 0.95));
  h.mutate(document.body, els); h.flush(); await h.send();
  expect(h.calls).toHaveLength(0);
  expect(treated(els)).toHaveLength(modelGroupCap(els.length));
  expect(h.overCapped.flat()).toEqual([keyOf(els[0] as Element)]);
});

test("a model group at the cap is treated in full and records nothing", async () => {
  const h = harness(); await h.ready();
  const els = group(MIN_MODEL_GROUP, "2h");
  h.response(poison(keyOf(els[0] as Element)));
  h.mutate(document.body, els); h.flush();
  await h.send(); h.flush();
  expect(modelGroupCap(els.length)).toBe(MIN_MODEL_GROUP);
  expect(treated(els)).toHaveLength(MIN_MODEL_GROUP);
  expect(els.every((el) => el.dataset.jev === "hide")).toBe(true);
  expect(h.overCapped).toEqual([]);
});

test("an item already treated by a model verdict stays treated when the group goes over", async () => {
  const h = harness(); await h.ready(); h.painted();
  const first = group(MIN_MODEL_GROUP, "2h");
  const key = keyOf(first[0] as Element);
  h.response(poison(key));
  h.mutate(document.body, first); h.flush(); await h.send(); h.flush();
  const before = first.map((el) => el.getAttribute("data-jev"));
  const late = group(3, "2h");
  h.mutate(document.body, late);
  h.scanner.updateCache(cachedVerdict(key, 0.95)); h.flush();
  expect(before).toEqual(first.map(() => "hide"));
  expect(first.map((el) => el.getAttribute("data-jev"))).toEqual(before);
  expect(treated(late)).toHaveLength(0);
  expect(late.some((el) => el.hasAttribute("data-jev-held"))).toBe(false);
});

test("ten real-ad cells of one key recycled four times all stay treated", async () => {
  const h = harness(); await h.ready();
  const cells = group(10, "2h");
  const adKey = keyOf(cells[0] as Element);
  h.response(poison(adKey));
  h.mutate(document.body, cells); h.flush(); await h.send(); h.flush();
  expect(treated(cells)).toHaveLength(10);
  for (let round = 0; round < 4; round++) {
    for (const el of cells) {
      const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
    }
    await h.send(); h.flush();
    for (const el of cells) {
      el.querySelector("img")?.remove(); h.mutate(el, []); h.flush();
    }
  }
  expect(treated(cells)).toHaveLength(10);
  expect(cells.every((el) => el.dataset.jev === "hide")).toBe(true);
  expect(h.overCapped).toEqual([]);
});

test("re-processing the same element under the same key never charges twice", async () => {
  const h = harness();
  const els = group(MIN_MODEL_GROUP + 1, "2h");
  const key = keyOf(els[0] as Element);
  const c = cachedVerdict(key, 0.95);
  await h.ready(DEFAULT_SETTINGS, c);
  h.mutate(document.body, els); h.flush();
  expect(treated(els)).toHaveLength(MIN_MODEL_GROUP);
  for (let i = 0; i < 3; i++) { h.scanner.updateCache(c); h.flush(); }
  for (const el of els.slice(0, MIN_MODEL_GROUP)) el.remove();
  const probe = item("99h");
  h.mutate(document.body, [probe]); h.flush(); await h.send();
  const fresh = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, fresh); h.flush();
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP);
});

for (const [size, cap] of [[100, 25], [20, MIN_MODEL_GROUP]] as const) {
  test(`the cap follows the observed item count: ${size} items -> ${cap}`, async () => {
    const h = harness();
    const els = group(size, "2h");
    await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(els[0] as Element), 0.95));
    h.mutate(document.body, els); h.flush();
    expect(modelGroupCap(size)).toBe(cap);
    expect(treated(els)).toHaveLength(cap);
    expect(h.scanner.qa.observedItems).toBe(size);
  });
}

test("disconnecting a treated item frees its charge while a held item keeps it", async () => {
  const h = harness();
  const els = group(MIN_MODEL_GROUP + 2, "2h");
  const key = keyOf(els[0] as Element);
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(key, 0.95));
  h.mutate(document.body, els); h.flush();
  const [first, second] = els;
  const refused = els.slice(MIN_MODEL_GROUP);
  if (!first || !second) throw new Error("missing fixture");
  expect(treated(refused)).toHaveLength(0);
  first.remove();
  const probe = item("99h");
  h.mutate(document.body, [probe]); h.flush(); await h.send();
  h.mutate(refused[0] as Element); h.flush();
  expect((refused[0] as Element).getAttribute("data-jev")).toBe("hide");
  h.painted();
  const img = document.createElement("img"); second.append(img);
  h.mutate(second, [img]); h.flush();
  expect(second.getAttribute("data-jev")).toBe("hide");
  expect(second.hasAttribute("data-jev-held")).toBe(true);
  h.mutate(refused[1] as Element); h.flush();
  expect((refused[1] as Element).hasAttribute("data-jev")).toBe(false);
});

test("a fully cached page view frees the slots of items it never re-requests", async () => {
  const h = harness();
  const cells = group(MIN_MODEL_GROUP, "2h");
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(cells[0] as Element), 0.95));
  h.mutate(document.body, cells); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  for (const el of cells) el.remove();
  const fresh = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, fresh); h.flush();
  expect(h.calls).toHaveLength(0);
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP);
});

test("a held then removed cell frees the slot of the key that paid for it", async () => {
  const h = harness();
  const cells = group(MIN_MODEL_GROUP, "2h");
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(keyOf(cells[0] as Element), 0.95));
  h.mutate(document.body, cells); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  h.painted();
  const held = cells.slice(0, 8);
  for (const el of held) {
    Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 100, width: 100, height: 100 }) });
    const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
  }
  expect(held.every((el) => el.hasAttribute("data-jev-held") && el.dataset.jev === "hide")).toBe(true);
  for (const el of held) el.remove();
  const fresh = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, fresh); h.flush();
  expect(h.calls).toHaveLength(0);
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP - 7);
});

test("navigation clears the charges and the observed item count", async () => {
  const h = harness(); await h.ready();
  h.response(poisonAll);
  const els = group(MIN_MODEL_GROUP + 1, "2h");
  h.mutate(document.body, els); h.flush(); await h.send(); h.flush();
  const refused = els[MIN_MODEL_GROUP];
  if (!refused) throw new Error("missing fixture");
  expect(treated(els)).toHaveLength(MIN_MODEL_GROUP);
  expect(refused.hasAttribute("data-jev")).toBe(false);
  expect(h.overCapped).toHaveLength(1);
  for (const el of els.slice(0, 10)) el.remove();
  window.history.pushState(null, "", "/explore");
  h.mutate(document.body); h.flush(); await h.send(); h.flush();
  expect(h.scanner.qa.observedItems).toBe(MIN_MODEL_GROUP + 1 - 10);
  expect(treated(els.slice(10))).toHaveLength(MIN_MODEL_GROUP + 1 - 10);
  expect(refused.getAttribute("data-jev")).toBe("hide");
  expect(h.overCapped).toHaveLength(1);
});

test("a held item leaves the verdict it did not apply a full budget", async () => {
  const h = harness(); await h.ready();
  h.response(poisonAll);
  const cells = group(MIN_MODEL_GROUP, "2h");
  h.mutate(document.body, cells); h.flush(); await h.send(); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  h.painted();
  for (const el of cells) {
    Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 100, width: 100, height: 100 }) });
    const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
  }
  await h.send(); h.flush();
  expect(cells.filter((el) => el.hasAttribute("data-jev-held"))).toHaveLength(MIN_MODEL_GROUP);
  expect(cells.every((el) => el.dataset.jev === "hide")).toBe(true);
  const fresh = Array.from({ length: MIN_MODEL_GROUP }, () => {
    const el = item("2h", 2000); el.append(document.createElement("img")); return el;
  });
  h.mutate(document.body, fresh); h.flush(); await h.send(); h.flush();
  expect(treated(fresh)).toHaveLength(MIN_MODEL_GROUP);
});

test("a cache re-notification at the cap never withdraws an existing hide", async () => {
  const h = harness();
  const cells = group(MIN_MODEL_GROUP, "2h");
  const c = cachedVerdict(keyOf(cells[0] as Element), 0.95);
  await h.ready(DEFAULT_SETTINGS, c);
  h.mutate(document.body, cells); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  h.scanner.updateCache(c); h.flush();
  expect(treated(cells)).toHaveLength(MIN_MODEL_GROUP);
  expect(cells.every((el) => el.dataset.jev === "hide")).toBe(true);
  expect(cells.some((el) => el.hasAttribute("data-jev-held"))).toBe(false);
});

test("a key whose live group never exceeds the cap is never recorded", async () => {
  const h = harness(); await h.ready();
  const mine = group(10, "2h");
  const others = group(50, "Sponsored");
  h.response(poison(keyOf(mine[0] as Element)));
  h.mutate(document.body, [...mine, ...others]); h.flush(); await h.send(); h.flush();
  for (let round = 0; round < 4; round++) {
    for (const el of mine) {
      const img = document.createElement("img"); el.append(img); h.mutate(el, [img]); h.flush();
    }
    await h.send(); h.flush();
    for (const el of mine) {
      el.querySelector("img")?.remove(); h.mutate(el, []); h.flush();
    }
  }
  expect(treated(mine)).toHaveLength(10);
  expect(treated(others)).toHaveLength(50);
  expect(h.overCapped).toEqual([]);
});

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
  const h = harness();
  const el = unknownAt(0);
  await h.ready(DEFAULT_SETTINGS, undefined, overrideMap(keyOf(el), "keep"));
  h.painted();
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
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
  h.mutate(document.body, [below, inView]); h.flush(); await h.send(); h.flush();
  expect(h.calls).toHaveLength(0);
  expect(below.dataset.jev).toBe("hide");
  expect(inView.dataset.jev).toBe("hide");
  expect(h.prompts.size).toBe(0);
});

test("an answer never overrides a deterministic verdict and a deterministic item never gets a prompt", async () => {
  const h = harness();
  const inView = item("Sponsored", 0);
  const below = item("Sponsored", 2000);
  await h.ready(DEFAULT_SETTINGS, undefined, overrideMap(keyOf(inView), "keep"));
  h.painted();
  h.mutate(document.body, [inView, below]); h.flush();
  expect(inView.dataset.jev).toBe("hide");
  expect(below.dataset.jev).toBe("hide");
  expect(h.prompts.size).toBe(0);
});

test("the prompt appears only on a model blur, never on a hide, a deterministic item or a module", async () => {
  const h = harness(); await h.ready(); h.painted();
  const modelInView = unknownAt(0);
  const modelBelow = unknownAt(2000);
  const deterministicInView = item("Sponsored", 0);
  const mod = moduleItem(0);
  const key = keyOf(modelInView);
  h.response(poison(key));
  h.mutate(document.body, [modelInView, modelBelow, deterministicInView, mod]); h.flush();
  await h.send(); h.flush();
  expect(modelInView.dataset.jev).toBe("blur");
  expect(modelBelow.dataset.jev).toBe("hide");
  expect(deterministicInView.dataset.jev).toBe("hide");
  expect(mod.dataset.jev).toBe("hide");
  expect([...h.prompts.keys()]).toEqual([modelInView]);
  expect(h.prompt(modelInView)).toBe(key);
});

test("answering no unblurs the item, releases every same-key item and sends nothing", async () => {
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
  h.answer(key, "keep");
  expect(inView.hasAttribute("data-jev")).toBe(false);
  expect(second.hasAttribute("data-jev")).toBe(false);
  expect(below.hasAttribute("data-jev")).toBe(false);
  expect(localAd.dataset.jev).toBe("hide");
  expect(h.saved).toEqual([{ key, decision: "keep" }]);
  expect(h.calls).toHaveLength(before);
  expect(h.prompts.size).toBe(0);
});

test("answering yes keeps the treatment, persists the confirmation and drops the prompt", async () => {
  const h = harness(); await h.ready(); h.painted();
  const inView = unknownAt(0);
  const below = unknownAt(2000);
  const key = keyOf(inView);
  h.response(poison(key));
  h.mutate(document.body, [inView, below]); h.flush(); await h.send(); h.flush();
  expect(h.prompt(inView)).toBe(key);
  const before = h.calls.length;
  h.answer(key, "confirmed");
  expect(inView.dataset.jev).toBe("hide");
  expect(below.dataset.jev).toBe("hide");
  expect(h.saved).toEqual([{ key, decision: "confirmed" }]);
  expect(h.calls).toHaveLength(before);
  expect(h.prompts.size).toBe(0);
});

test("a reload applies the stored answer ahead of the cached model verdict", async () => {
  const h = harness();
  const el = unknownAt(0);
  const key = keyOf(el);
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(key, 0.95), overrideMap(key, "keep"));
  h.painted();
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false);
  expect(h.calls).toHaveLength(0);
  expect(h.prompts.size).toBe(0);
});

test("a keep answer returns every cap slot the model verdict was holding", async () => {
  const h = harness(); await h.ready();
  const els = group(100, "2h");
  const key = keyOf(els[0] as Element);
  h.response(poison(key));
  h.mutate(document.body, els); h.flush(); await h.send(); h.flush();
  expect(treated(els)).toHaveLength(modelGroupCap(els.length));
  expect(h.overCapped.at(-1)).toEqual([key]);
  h.answer(key, "keep");
  expect(treated(els)).toHaveLength(0);
  expect(h.saved).toEqual([{ key, decision: "keep" }]);
});

test("a detached item loses its prompt in the scanner's own sweep", async () => {
  const h = harness(); await h.ready(); h.painted();
  const el = unknownAt(0);
  const key = keyOf(el);
  h.response(poison(key));
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  expect(h.prompt(el)).toBe(key);
  h.mutate(document.body, [item("3h", 2000)]); h.flush();
  el.remove();
  await h.send();
  expect(h.prompts.size).toBe(0);
});

test("a flush drops the prompt of an item the page detached without telling the scanner", async () => {
  const h = harness(); await h.ready(); h.painted();
  const el = unknownAt(0);
  h.response(poison(keyOf(el)));
  h.mutate(document.body, [el]); h.flush(); await h.send(); h.flush();
  expect(h.prompts.size).toBe(1);
  el.remove();
  h.mutate(document.body, [item("Sponsored", 2000)]); h.flush();
  expect(h.prompts.size).toBe(0);
});

test("an SPA navigation re-reads the stored answers, so a cleared answer applies again", async () => {
  const h = harness();
  const el = unknownAt(2000);
  const key = keyOf(el);
  await h.ready(DEFAULT_SETTINGS, cachedVerdict(key, 0.95), overrideMap(key, "keep"));
  h.mutate(document.body, [el]); h.flush();
  expect(el.hasAttribute("data-jev")).toBe(false);
  h.setOverrides(undefined);
  window.history.pushState(null, "", "/home/latest");
  h.mutate(document.body); h.flush();
  await h.overridesRead();
  h.flush();
  expect(el.dataset.jev).toBe("hide");
});

test("DOMContentLoaded does not enqueue already processed initial items again", async () => {
  const h = harness(); await h.ready(); const el = item();
  h.mutate(document.body, [el]); h.flush(); const before = h.observations.length;
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(h.observations).toHaveLength(before);
});

function readingScene(victimTop: number, anchorTop: number) {
  const victim = item("Sponsored", victimTop);
  const anchor = item("", anchorTop);
  const moveAnchorTo = (top: number) => {
    Object.defineProperty(anchor, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 }) });
  };
  return { victim, anchor, moveAnchorTo };
}

async function hideWithAnchor(victimTop: number) {
  const h = harness(); await h.ready(); h.painted();
  const scene = readingScene(victimTop, 300);
  h.readingCandidates(scene.anchor, scene.anchor, scene.anchor);
  h.mutate(document.body, [scene.victim]); h.flush();
  expect(scene.victim.getAttribute("data-jev")).toBe("hide");
  return { h, ...scene };
}

test("a hide above the viewport scrolls back the anchor's drift once the host has re-laid out", async () => {
  const { h, moveAnchorTo } = await hideWithAnchor(-500);
  h.deliverReadingResize();
  expect(h.scrolledBy).toEqual([]);
  moveAnchorTo(200);
  h.deliverReadingResize();
  expect(h.scrolledBy).toEqual([-100]);
});

test("a relayout the host defers to a later frame is still restored before that frame paints", async () => {
  const { h, moveAnchorTo } = await hideWithAnchor(-500);
  h.frame();
  moveAnchorTo(200);
  h.deliverReadingResize();
  expect(h.scrolledBy).toEqual([-100]);
});

test("the watcher targets a block descendant, deeper than the item whose resize round runs the flush", async () => {
  const h = harness(); await h.ready(); h.painted();
  const { victim, anchor } = readingScene(-500, 300);
  const block = document.createElement("div");
  Object.defineProperty(block, "clientHeight", { value: 80 });
  anchor.append(document.createElement("span"), block);
  Object.defineProperty(block, "getBoundingClientRect", { value: () => ({ top: 320, bottom: 400, left: 0, right: 100, width: 100, height: 80 }) });
  h.readingCandidates(anchor);
  h.mutate(document.body, [victim]); h.flush();
  expect([...(h.readingWatchers[0]?.targets ?? [])]).toEqual([block]);
});

test("a hide fully on screen never scrolls", async () => {
  const { h, moveAnchorTo } = await hideWithAnchor(100);
  moveAnchorTo(200);
  h.deliverReadingResize();
  expect(h.readingWatchers).toHaveLength(0);
  expect(h.scrolledBy).toEqual([]);
});

test("a user scroll is rebaselined and never fought", async () => {
  const { h, moveAnchorTo } = await hideWithAnchor(-500);
  h.userScroll(400);
  moveAnchorTo(-100);
  h.deliverReadingResize();
  expect(h.scrolledBy).toEqual([]);
});

test("restoring never scrolls further than the height hidden above the anchor", async () => {
  const { h, moveAnchorTo } = await hideWithAnchor(-500);
  moveAnchorTo(-700);
  h.deliverReadingResize();
  expect(h.scrolledBy).toEqual([-100]);
  moveAnchorTo(-900);
  h.deliverReadingResize();
  expect(h.scrolledBy).toEqual([-100]);
});

test("the hold ends after its frames and is released on stop", async () => {
  const { h, moveAnchorTo } = await hideWithAnchor(-500);
  h.frame(); h.frame(); h.frame();
  moveAnchorTo(200);
  h.deliverReadingResize();
  h.frame();
  expect(h.scrolledBy).toEqual([]);
});

function igSurface(path: string, html: string) {
  const h = harness(SITES.instagram);
  window.history.pushState(null, "", path);
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return { h, host };
}

const PEOPLE_ROW =
  '<div id="row"><div id="rowInner"><div><span><img alt="x"></span></div>' +
  '<div><span dir="auto"><span>caption</span></span></div><div><div><button type="button"><div><div dir="auto">Follow</div></div></button></div></div></div></div>';

test("suggested account rows on the suggested accounts page are hidden", async () => {
  const { h, host } = igSurface("/explore/people/", PEOPLE_ROW);
  await h.ready();
  h.mutate(document.body, [host]); h.flush();
  expect(host.querySelector("#rowInner")!.getAttribute("data-jev")).toBe("hide");
});

test("row and tile modules apply only on their own Instagram pages", () => {
  const [rows, tiles] = SITES.instagram.modules.filter((m) => m.paths).map((m) => m.paths!);
  expect(["/explore/people/", "/explore/people"].map((p) => rows!.test(p))).toEqual([true, true]);
  expect(["/", "/someone/", "/explore/", "/explore/tags/x/"].map((p) => rows!.test(p))).toEqual([false, false, false, false]);
  expect(["/explore/", "/explore"].map((p) => tiles!.test(p))).toEqual([true, true]);
  expect(["/", "/someone/", "/explore/people/", "/explore/tags/x/"].map((p) => tiles!.test(p))).toEqual([false, false, false, false]);
});

test("recommended post tiles on the Explore page are hidden", async () => {
  const tiles = '<div id="cell"><div><div><a role="link" href="/p/abc/"><img alt="x"></a></div></div></div>';
  const { h, host } = igSurface("/explore/", tiles);
  await h.ready();
  h.mutate(document.body, [host]); h.flush();
  expect(host.querySelector("#cell")!.getAttribute("data-jev")).toBe("hide");
});

const STORIES_TRAY =
  '<div id="tray" role="presentation"><div><ul><li></li><li tabindex="-1"><div role="button" aria-label="Story by x, not seen" tabindex="0">' +
  '<canvas></canvas><span role="link"><img alt="x"></span></div></li></ul></div></div>';

test("only the story avatar images are blurred, the tray stays clickable and unfiltered, and a late story changes nothing", async () => {
  const { h, host } = igSurface("/", STORIES_TRAY);
  await h.ready();
  h.mutate(document.body, [host]); h.flush();
  const tray = host.querySelector("#tray")!;
  expect(tray.getAttribute("data-jev")).toBe("blur");
  const li = document.createElement("li");
  tray.querySelector("ul")!.append(li);
  h.mutate(tray.querySelector("ul")!, [li]); h.flush();
  expect(tray.getAttribute("data-jev")).toBe("blur");
  expect(li.hasAttribute("data-jev")).toBe(false);
  const css = document.getElementById("jev-declutter")!.textContent!;
  expect(css).toContain('[data-jev="blur"]:not([role="presentation"]){filter:blur(10px)');
  expect(css).toContain('[data-jev="blur"][role="presentation"] [aria-label] img{filter:blur(10px)!important}');
  expect(tray.querySelector('[role="button"][aria-label] img')!.matches('[data-jev="blur"][role="presentation"] [aria-label] img')).toBe(true);
  expect(tray.querySelector("canvas")!.matches('[data-jev="blur"][role="presentation"] [aria-label] img')).toBe(false);
});

test("the stories tray is left alone when suggested content is not hidden", async () => {
  const { h, host } = igSurface("/", STORIES_TRAY);
  await h.ready({ ...DEFAULT_SETTINGS, hideSuggested: false });
  h.mutate(document.body, [host]); h.flush();
  expect(host.querySelector("[data-jev]")).toBeNull();
});

test("Instagram navigation links match under a locale query but hashtag links do not", () => {
  const modules = SITES.instagram.modules.map((m) => m.selector).join(",");
  const host = document.createElement("div");
  host.innerHTML =
    '<a id="a" href="/reels/?hl=ko"></a><a id="b" href="/explore/?hl=ko"></a><a id="c" href="/explore/"></a>' +
    '<a id="d" href="/explore/tags/cats/"></a><a id="e" href="/reels/abc/"></a>';
  expect([...host.querySelectorAll(modules)].map((el) => el.id)).toEqual(["a", "b", "c"]);
});

test("a Korean sponsored label in the account row is an ad label", () => {
  const article = document.createElement("article");
  article.innerHTML =
    '<div data-interactable><div><span dir="auto"><div><a role="link" href="#"><span>user</span></a></div></span></div>' +
    '<div><span dir="auto"><div><span>광고</span></div></span></div></div>';
  document.body.append(article);
  expect(deterministic(extractSignals(article, SITES.instagram), SITES.instagram)).toEqual({ category: "ad", p: 1 });
});
