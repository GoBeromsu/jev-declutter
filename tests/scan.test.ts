import { afterEach, expect, test } from "bun:test";
import { startScanner, type ScanHost, type Mutation } from "../src/scan";
import { SITES } from "../src/sites";
import { DEFAULT_SETTINGS } from "../src/storage";
import { freshCache, MAX_ITEMS, providerKey } from "../src/cache";
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
  const calls: Message[] = [];
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
  let response: () => Promise<ClassifyResult> = async () => ({ ok: true, scores: [{ ad: 0, suggested: 0.9 }] });
  const host: ScanHost = {
    settings: () => settings.promise, cache: () => cache.promise,
    send: async (msg) => { calls.push(msg); return response(); },
    painted: () => painted, now: () => now,
    mutations: (cb) => { mutation = cb; return () => {}; },
    resize: (cb) => { resize = cb; return { observe: (el) => { targets.add(el); observations.push(el); }, unobserve: (el) => { targets.delete(el); }, disconnect: () => targets.clear() }; },
    intersection: (cb) => { near = cb; return { observe: () => {}, unobserve: () => {}, disconnect: () => {} }; },
    frame: (cb) => { frame = cb; return 1; }, cancelFrame: () => { frame = undefined; },
    postTask: (cb) => { task = cb; },
    timer: (cb) => { timer = cb; return 1; }, cancelTimer: () => { timer = undefined; }
  };
  const scanner = startScanner(cfg, host);
  cleanups.push(scanner.stop);
  return {
    settings, cache, calls, targets, observations, scanner,
    painted: () => { painted = true; },
    time: (value: number) => { now = value; },
    response: (fn: () => Promise<ClassifyResult>) => { response = fn; },
    mutate: (target: Node, addedNodes: Node[] = []) => mutation([{ target, addedNodes }]),
    mutations: (records: readonly Mutation[]) => mutation(records),
    flush: () => resize(),
    frame: () => { const cb = frame; frame = undefined; cb?.(now); },
    task: () => { const cb = task; task = undefined; cb?.(); },
    hasFrame: () => frame !== undefined,
    near: (elements: Element[]) => near(elements),
    send: async () => { const cb = timer; timer = undefined; await cb?.(); },
    ready: async (value = DEFAULT_SETTINGS, c?: SignatureCache) => {
      settings.resolve(value); cache.resolve(c); await settings.promise; await cache.promise;
    }
  };
}

function item(label = "Sponsored", top = 1000) {
  const el = document.createElement("div");
  el.dataset.testid = "cellInnerDiv";
  if (label) el.innerHTML = `<div data-testid="socialContext">${label}</div>`;
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + 100, width: 100, height: 100 }) });
  document.body.append(el);
  return el;
}

for (const path of ["ro", "mutation"] as const) {
  for (const [painted, top, expected] of [[false, 0, "hide"], [true, 0, "blur"], [true, 2000, "hide"]] as const) {
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
    const h = harness(); const previous = item("", below ? 2000 : 0); const el = item();
    h.mutate(document.body, [previous, el]); h.flush(); h.painted();
    await h.ready({ ...DEFAULT_SETTINGS, actions: { ad: "keep", suggested: "keep", module: "keep" } }); h.flush();
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
  expect(aside.dataset.jev).toBe("blur");
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

test("blur never upgrades to hide when a later cache verdict arrives below viewport", async () => {
  const h = harness(); await h.ready(); h.painted(); const el = item("Sponsored", 0);
  h.mutate(document.body, [el]); h.flush();
  Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ top: 2000 }) });
  h.mutate(el); h.flush();
  expect(el.dataset.jev).toBe("blur");
});

test("settings changes are deferred until navigation", async () => {
  const h = harness(); await h.ready(); const el = item();
  h.scanner.nextSettings({ ...DEFAULT_SETTINGS, actions: { ad: "keep", suggested: "keep", module: "keep" } });
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
  expect(section.dataset.jev).toBe("blur");
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
  expect(ad.dataset.jev).toBe("blur");
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
  // later in-view verdict still blurs instead of collapsing presented content.
  h.frame(); h.task();
  const late = item("Sponsored", 0);
  h.mutate(document.body, [late]); h.flush();
  expect(late.dataset.jev).toBe("blur");
  expect(getComputedStyle(late).display).not.toBe("none");
});

test("settings inside paint publication gap preserve the existing hidden-item hold", async () => {
  // Given: a pre-paint hidden ad and a displayed item in a later content frame.
  const h = harness(); const ad = item("Sponsored", 0);
  h.mutate(document.body, [ad]); h.flush();
  const visible = item("2h", 400); h.mutate(document.body, [visible]);
  h.frame(); h.task();
  // When: settings resolve after presentation but the paint-entry source stays false.
  await h.ready({ ...DEFAULT_SETTINGS, actions: { ...DEFAULT_SETTINGS.actions, ad: "keep" } });
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

test("currently visible item still downgrades a late in-view hide verdict to blur", () => {
  // Given
  const h = harness(); h.painted(); const el = item("Sponsored", 100);
  // When
  h.mutate(document.body, [el]); h.flush();
  // Then
  expect(el.dataset.jev).toBe("blur");
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

test("DOMContentLoaded does not enqueue already processed initial items again", async () => {
  // Given
  const h = harness(); await h.ready(); const el = item();
  h.mutate(document.body, [el]); h.flush(); const before = h.observations.length;
  // When
  document.dispatchEvent(new Event("DOMContentLoaded"));
  // Then
  expect(h.observations).toHaveLength(before);
});
