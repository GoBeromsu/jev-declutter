import { beforeEach, expect, test } from "bun:test";
import {
  DAILY_REQUEST_BUDGET,
  PER_MINUTE_CAP,
  consumeBudget,
  ensureCurrent,
  freshCache,
  loadSigCache,
  lookup,
  providerKey,
  remember,
  saveSigCache,
  tryConsume
} from "../src/cache";
import { today } from "../src/decide";
import { signalKey } from "../src/signature";
import { budgetKey, sigKey } from "../src/storage";
import type { ItemDescriptor, Settings, SignatureCache, SignatureVerdict } from "../src/types";

const store: Record<string, unknown> = {};

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: clone(store[key]) } : {}),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, clone(values));
        }
      }
    }
  }
});

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

const settings = (provider: "openai" | "typesafe", openaiModel: string, typesafeModel: string): Settings =>
  ({
    provider,
    openai: { apiKey: "", model: openaiModel },
    typesafe: { apiKey: "", model: typesafeModel }
  }) as Settings;

const verdict = (ad: number | null): SignatureVerdict => ({ ad, suggested: null });

const at = (y: number, m: number, d: number, h: number, min: number, s = 0) => new Date(y, m - 1, d, h, min, s);

const SIGNALS: Pick<
  ItemDescriptor,
  "chrome_text" | "has_follow_button" | "has_external_link" | "ad_attribute" | "media" | "path_kind"
> = {
  chrome_text: [],
  has_follow_button: false,
  has_external_link: true,
  ad_attribute: false,
  media: "none",
  path_kind: "feed"
};

const realKey = (n: number, signals = SIGNALS): string =>
  signalKey(`youtube:${n.toString(16).padStart(8, "0")}`, signals);

const IMAGE_SIGNALS = { ...SIGNALS, media: "image" as const };
const VIDEO_SIGNALS = { ...SIGNALS, media: "video" as const };

const DIGIT_KEYS: [string, string, string, string, string] = [
  realKey(0x19, IMAGE_SIGNALS),
  realKey(0x14, VIDEO_SIGNALS),
  realKey(0x38),
  realKey(0x3b),
  realKey(0x4f, VIDEO_SIGNALS)
];
const d0 = DIGIT_KEYS[0];
const d1 = DIGIT_KEYS[1];
const d2 = DIGIT_KEYS[2];
const d3 = DIGIT_KEYS[3];
const LETTER_KEYS = Array.from({ length: 40 }, (_, i) => realKey(i)).filter((k) => !/^[0-9]{8}$/.test(k));

const insertionOrder = (c: SignatureCache): string[] => Object.keys(c.entries);

test("providerKey embeds the ACTIVE provider's model, provider and question version", () => {
  const openai = settings("openai", "gpt-6-luna", "jev-latest");
  const typesafe = settings("typesafe", "gpt-6-luna", "jev-latest");
  expect(providerKey(openai)).toBe("openai:gpt-6-luna:1");
  expect(providerKey(typesafe)).toBe("typesafe:jev-latest:1");
  expect(providerKey(settings("openai", "other-model", "jev-latest"))).toBe("openai:other-model:1");
});

test("freshCache starts empty for the given day and provider key", () => {
  const c = freshCache("2026-10-28", "openai:gpt-6-luna:1");
  expect(c).toEqual({ day: "2026-10-28", providerKey: "openai:gpt-6-luna:1", entries: {}, order: [] });
});

test("ensureCurrent(undefined, ...) returns an empty cache without throwing", () => {
  const c = ensureCurrent(undefined, "2026-10-28", "openai:gpt-6-luna:1");
  expect(c.entries).toEqual({});
  expect(c.order).toEqual([]);
  expect(c.day).toBe("2026-10-28");
  expect(c.providerKey).toBe("openai:gpt-6-luna:1");
});

test("ensureCurrent keeps the same cache on the same day and key", () => {
  const c = remember(freshCache("2026-10-28", "k"), { [realKey(1)]: verdict(0.9) });
  const same = ensureCurrent(c, "2026-10-28", "k");
  expect(lookup(same, realKey(1))).toEqual(verdict(0.9));
});

test("stale_state: a new LOCAL day empties the cached entries", () => {
  const evening = at(2026, 10, 28, 23, 59);
  const morning = at(2026, 10, 29, 0, 1);
  const day1 = today(evening);
  const day2 = today(morning);
  expect(day2).not.toBe(day1);

  const c = remember(freshCache(day1, "k"), { [realKey(2)]: verdict(0.9) });
  const next = ensureCurrent(c, day2, "k");
  expect(next.entries).toEqual({});
  expect(next.order).toEqual([]);
  expect(next.day).toBe(day2);
  expect(lookup(next, realKey(2))).toBeUndefined();
  expect(lookup(c, realKey(2))).toEqual(verdict(0.9));
});

test("stale_state: a provider, model or QUESTION_VERSION change empties entries", () => {
  const base = "openai:gpt-6-luna:1";
  const c = remember(freshCache("2026-10-28", base), { [realKey(3)]: verdict(0.9) });
  for (const other of ["typesafe:jev-latest:1", "openai:gpt-several:1", "openai:gpt-6-luna:2"]) {
    expect(other).not.toBe(base);
    const next = ensureCurrent(c, "2026-10-28", other);
    expect(next.entries).toEqual({});
    expect(next.order).toEqual([]);
    expect(next.providerKey).toBe(other);
  }
});

test("providerKey change between two Settings values invalidates the cache", () => {
  const before = providerKey(settings("openai", "gpt-6-luna", "jev-latest"));
  const after = providerKey(settings("typesafe", "gpt-6-luna", "jev-latest"));
  const c = remember(freshCache("2026-10-28", before), { [realKey(4)]: verdict(0.9) });
  expect(ensureCurrent(c, "2026-10-28", after).entries).toEqual({});
});

test("remember stores by real signalKey and lookup finds it", () => {
  const key = realKey(5);
  const c = remember(undefined, { [key]: verdict(0.7) });
  expect(lookup(c, key)).toEqual(verdict(0.7));
  expect(lookup(c, realKey(6))).toBeUndefined();
});

test("remember merges entries and keeps the newest verdict on a repeat key", () => {
  const a = realKey(7);
  const b = realKey(8);
  const c = remember(remember(undefined, { [a]: verdict(0.1), [b]: verdict(0.2) }), { [b]: verdict(0.9), [a]: verdict(0.3) });
  expect(c.order).toEqual([a, b]);
  expect(lookup(c, b)).toEqual(verdict(0.9));
  expect(lookup(c, a)).toEqual(verdict(0.3));
});

test("cap evicts the oldest entries in true insertion order", () => {
  let c: SignatureCache | undefined;
  const keys: [string, string, string, string, string] = [realKey(10), realKey(11), realKey(12), realKey(13), realKey(14)];
  for (const [i, k] of keys.entries()) c = remember(c, { [k]: verdict(i / 10) }, 3);
  expect(c?.order).toEqual(keys.slice(2));
  expect(Object.values(c?.entries ?? {})).toEqual([verdict(0.2), verdict(0.3), verdict(0.4)]);
});

test("cap keeps real all-digit signalKeys in insertion order, newest never evicted", () => {
  for (const k of DIGIT_KEYS) expect(k).toMatch(/^[0-9]{8}$/);
  const letter = LETTER_KEYS[0] as string;

  let c = remember(freshCache("2026-10-28", "k"), { [letter]: verdict(0) }, 1);
  c = remember(c, { [d0]: verdict(1) }, 1);
  expect(c.order).toEqual([d0]);
  expect(insertionOrder(c)).toEqual([d0]);
  expect(c.entries).toEqual({ [d0]: verdict(1) });

  c = remember(c, { [d1]: verdict(2) }, 1);
  expect(c.order).toEqual([d1]);
  expect(Object.values(c.entries)).toEqual([verdict(2)]);

  c = remember(c, { [d2]: verdict(3), [d3]: verdict(4), [letter]: verdict(5) }, 3);
  expect(c.order).toEqual([d2, d3, letter]);
  expect(insertionOrder(c)).toEqual([d2, d3, letter]);
  expect(lookup(c, d1)).toBeUndefined();
  expect(lookup(c, d2)).toEqual(verdict(3));
});

test("the eviction order survives a JSON storage round trip", () => {
  const letter = LETTER_KEYS[1] as string;
  let c = remember(freshCache("2026-10-28", "k"), { [d0]: verdict(0) }, 4);
  c = remember(c, { [letter]: verdict(1) });
  c = remember(c, { [d1]: verdict(2) });
  c = remember(c, { [d2]: verdict(3) });

  const stored: unknown = JSON.parse(JSON.stringify(c));
  const revived = ensureCurrent(stored as SignatureCache, "2026-10-28", "k");
  expect(revived.order).toEqual([d0, letter, d1, d2]);
  const next = realKey(20);
  const evicted = remember(revived, { [next]: verdict(9) }, 4);
  expect(evicted.order).toEqual([letter, d1, d2, next]);
  expect(lookup(evicted, d0)).toBeUndefined();
});

test("a same-day same-provider cache with no order is stale-format and yields an empty cache", () => {
  const a = realKey(30);
  const stale = { day: "2026-10-28", providerKey: "k", entries: { [a]: verdict(0.5) } };
  const c = ensureCurrent(stale as unknown as SignatureCache, "2026-10-28", "k");
  expect(c.entries).toEqual({});
  expect(c.order).toEqual([]);
  expect(c.day).toBe("2026-10-28");
  expect(c.providerKey).toBe("k");
  expect(lookup(c, a)).toBeUndefined();
});

test("same-format order repairs drop unknown and duplicate keys and re-add missing ones", () => {
  const a = realKey(31);
  const b = realKey(32);
  const raw = { day: "2026-10-28", providerKey: "k", entries: { [a]: verdict(0.5), [b]: verdict(0.6) }, order: [b, "gone", b] };
  const c = ensureCurrent(raw as unknown as SignatureCache, "2026-10-28", "k");
  expect(c.order).toEqual([b, a]);
  expect(lookup(c, a)).toEqual(verdict(0.5));
  expect(lookup(c, b)).toEqual(verdict(0.6));
});

test("T8-OLDEST: a stale-format cache never loses its newest entry to an older one", () => {
  const older = realKey(0x0);
  const newestExisting = realKey(0x38);
  const incoming = realKey(0x2);
  expect(older).toBe("ba499cf2");
  expect(newestExisting).toBe("36468265");
  expect(incoming).toBe("f60388dc");
  const stale = { day: "2026-10-28", providerKey: "k", entries: { [older]: verdict(0.1), [newestExisting]: verdict(0.2) } };

  const c = remember(ensureCurrent(stale as unknown as SignatureCache, "2026-10-28", "k"), { [incoming]: verdict(0.3) }, 2);
  expect(c.order).toEqual([incoming]);
  expect(lookup(c, newestExisting)).toBeUndefined();
  expect(lookup(c, incoming)).toEqual(verdict(0.3));

  let full = freshCache("2026-10-28", "k");
  for (let i = 0; i < 1999; i++) full = remember(full, { [realKey(0x100 + i)]: verdict(0) });
  full = remember(full, { [newestExisting]: verdict(0.2) });
  expect(full.order.length).toBe(2000);
  expect(full.order[full.order.length - 1]).toBe(newestExisting);
  const next = remember(full, { [incoming]: verdict(0.3) });
  expect(next.order.length).toBe(2000);
  expect(next.order[next.order.length - 1]).toBe(incoming);
  expect(lookup(next, newestExisting)).toEqual(verdict(0.2));
  expect(lookup(next, full.order[0] as string)).toBeUndefined();
});

test("malformed cache input is treated as fresh, no throw", () => {
  for (const bad of ["garbage", 42, null, [], { day: "2026-10-28" }, { day: "2026-10-28", providerKey: "k", entries: "x" }]) {
    const c = ensureCurrent(bad as unknown as SignatureCache, "2026-10-28", "k");
    expect(c.entries).toEqual({});
    expect(c.order).toEqual([]);
    expect(c.day).toBe("2026-10-28");
  }
  const raw = {
    day: "2026-10-28",
    providerKey: "k",
    entries: { broken: "x", [realKey(31)]: { ad: 0.5, suggested: null } },
    order: ["broken", realKey(31)]
  };
  const c = ensureCurrent(raw as unknown as SignatureCache, "2026-10-28", "k");
  expect(c.order).toEqual([realKey(31)]);
});

test("lookup on undefined or malformed cache misses", () => {
  expect(lookup(undefined, "a")).toBeUndefined();
  expect(lookup("x" as unknown as SignatureCache, "a")).toBeUndefined();
});

test("budget constants match the plan", () => {
  expect(DAILY_REQUEST_BUDGET).toBe(300);
  expect(PER_MINUTE_CAP).toBe(30);
});

test("tryConsume allows exactly the per-minute cap and denies the 31st request", () => {
  const now = at(2026, 10, 28, 12, 0, 5);
  let state = tryConsume(undefined, now).next;
  expect(state.count).toBe(1);
  for (let i = 2; i <= PER_MINUTE_CAP; i++) {
    const r = tryConsume(state, now);
    expect(r.ok).toBe(true);
    state = r.next;
  }
  expect(state.minuteCount).toBe(30);
  const denied = tryConsume(state, now);
  expect(denied.ok).toBe(false);
  expect(denied.next).toEqual(state);
});

test("the next minute allows again", () => {
  const first = at(2026, 10, 28, 12, 0, 5);
  let state = tryConsume(undefined, first).next;
  for (let i = 1; i < PER_MINUTE_CAP; i++) state = tryConsume(state, first).next;
  expect(tryConsume(state, first).ok).toBe(false);
  const nextMinute = at(2026, 10, 28, 12, 1, 0);
  const r = tryConsume(state, nextMinute);
  expect(r.ok).toBe(true);
  expect(r.next.count).toBe(31);
  expect(r.next.minuteCount).toBe(1);
});

test("tryConsume is pure: a frozen input state is untouched", () => {
  const now = at(2026, 10, 28, 12, 0, 5);
  const state = Object.freeze({ day: today(now), count: 4, minute: Math.floor(now.getTime() / 60000), minuteCount: 2 });
  const r = tryConsume(state, now);
  expect(r.next).not.toBe(state);
  expect(state.count).toBe(4);
  expect(state.minuteCount).toBe(2);
  expect(r.next.count).toBe(5);
});

test("the 301st request of a day is denied", () => {
  let state = tryConsume(undefined, at(2026, 10, 28, 0, 0)).next;
  for (let i = 1; i < DAILY_REQUEST_BUDGET; i++) {
    const r = tryConsume(state, at(2026, 10, 28, 0, i));
    expect(r.ok).toBe(true);
    state = r.next;
  }
  expect(state.count).toBe(300);
  const denied = tryConsume(state, at(2026, 10, 28, 6, 0));
  expect(denied.ok).toBe(false);
  expect(denied.next.count).toBe(300);
});

test("a new day resets the daily count", () => {
  const state = { day: "2026-10-28", count: 300, minute: 0, minuteCount: 30 };
  const r = tryConsume(state, at(2026, 10, 29, 0, 0, 1));
  expect(r.ok).toBe(true);
  expect(r.next.day).toBe("2026-10-29");
  expect(r.next.count).toBe(1);
});

test("malformed or negative budget state is treated as fresh", () => {
  for (const bad of ["x", null, 7, [], { count: -5, minuteCount: -1 }, { day: "2026-10-28", count: Number.NaN, minute: 0, minuteCount: 0 }]) {
    const r = tryConsume(bad as never, at(2026, 10, 28, 12, 0));
    expect(r.ok).toBe(true);
    expect(r.next.count).toBe(1);
    expect(r.next.day).toBe("2026-10-28");
  }
});

test("storage: loadSigCache misses on empty storage", async () => {
  expect(await loadSigCache("x")).toBeUndefined();
});

test("storage: saveSigCache round-trips under sigKey(site)", async () => {
  const key = realKey(40);
  const c = remember(freshCache("2026-10-28", "k"), { [key]: verdict(0.9) });
  await saveSigCache("youtube", c);
  expect(store[sigKey("youtube")]).toEqual(c);
  expect(await loadSigCache("youtube")).toEqual(c);
  expect(await loadSigCache("x")).toBeUndefined();
});

test("worker restart: budget continues from chrome.storage.local, not memory", async () => {
  const key = budgetKey("2026-10-28");
  const now = at(2026, 10, 28, 12, 0, 5);
  for (let i = 0; i < 3; i++) {
    const r = await consumeBudget(today(now), now);
    expect(r.ok).toBe(true);
  }
  expect((store[key] as { count: number }).count).toBe(3);

  const fresh = (await import(`${import.meta.dir}/../src/cache.ts?restart=1`)) as typeof import("../src/cache");
  const r = await fresh.consumeBudget(today(now), now);
  expect(r.ok).toBe(true);
  expect((store[key] as { count: number }).count).toBe(4);
  expect((store[key] as { minuteCount: number }).minuteCount).toBe(4);

  store[key] = { day: "2026-10-28", count: 10, minute: fresh.tryConsume(undefined, now).next.minute, minuteCount: fresh.PER_MINUTE_CAP };
  const again = (await import(`${import.meta.dir}/../src/cache.ts?restart=2`)) as typeof import("../src/cache");
  expect((await again.consumeBudget(today(now), now)).ok).toBe(false);
  expect((store[key] as { count: number }).count).toBe(10);
});

test("consumeBudget writes only the budget:<day> key", async () => {
  await consumeBudget("2026-10-28", at(2026, 10, 28, 12, 0));
  expect(Object.keys(store)).toEqual([budgetKey("2026-10-28")]);
});

test("concurrent consumeBudget at count=299 grants exactly one of four", async () => {
  const now = at(2026, 10, 28, 12, 0);
  const key = budgetKey("2026-10-28");
  store[key] = { day: today(now), count: 299, minute: Math.floor(now.getTime() / 60000), minuteCount: 4 };
  const results = await Promise.all(Array.from({ length: 4 }, () => consumeBudget(today(now), now)));
  expect(results.filter((r) => r.ok).length).toBe(1);
  expect(results.filter((r) => !r.ok).length).toBe(3);
  expect((store[key] as { count: number }).count).toBe(300);
});

test("concurrent consumeBudget at minuteCount=29 grants exactly one of four", async () => {
  const now = at(2026, 10, 28, 12, 0);
  const key = budgetKey("2026-10-28");
  const minute = Math.floor(now.getTime() / 60000);
  store[key] = { day: today(now), count: 40, minute, minuteCount: 29 };
  const results = await Promise.all(Array.from({ length: 4 }, () => consumeBudget(today(now), now)));
  expect(results.filter((r) => r.ok).length).toBe(1);
  expect(results.filter((r) => !r.ok).length).toBe(3);
  expect(store[key]).toEqual({ day: today(now), count: 41, minute, minuteCount: 30 });
});
