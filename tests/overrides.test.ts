import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearOverCap, loadOverCap, recordOverCap } from "../src/cache";
import { today } from "../src/decide";
import {
  clearOverride,
  clearOverrides,
  emptyOverrides,
  loadOverrides,
  lookupOverride,
  normalizeOverrides,
  overrideKey,
  saveOverride
} from "../src/overrides";
import { sigKey } from "../src/storage";
import type { SiteId } from "../src/types";

const SITE_IDS: readonly SiteId[] = ["youtube", "x", "instagram", "linkedin"];

const store: Record<string, unknown> = {};
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

const keysOf = (keys: unknown): string[] =>
  keys === null || keys === undefined ? Object.keys(store) : typeof keys === "string" ? [keys] : (keys as string[]);

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (keys: unknown) => {
          const out: Record<string, unknown> = {};
          for (const k of keysOf(keys)) if (Object.hasOwn(store, k)) out[k] = clone(store[k]);
          return out;
        },
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, clone(values));
        },
        remove: async (keys: string | string[]) => {
          for (const k of typeof keys === "string" ? [keys] : keys) delete store[k];
        }
      }
    }
  }
});

let networkCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  networkCalls = 0;
  globalThis.fetch = ((..._args: unknown[]) => {
    networkCalls++;
    throw new Error("the override path must never reach the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("saveOverride stores only the signalKey, the decision and a timestamp, and sends nothing", async () => {
  await saveOverride("x", "1fd217c7", "keep", 1_700_000_000_000);
  expect(store[overrideKey("x")]).toStrictEqual({ entries: { "1fd217c7": { decision: "keep", at: 1_700_000_000_000 } } });
  const record = store[overrideKey("x")] as Record<string, unknown>;
  expect(Object.keys(record)).toEqual(["entries"]);
  expect(Object.keys((record.entries as Record<string, Record<string, unknown>>)["1fd217c7"] ?? {}).sort()).toEqual(["at", "decision"]);
  expect(networkCalls).toBe(0);
});

test("answers merge per site, the newest answer for one key wins and other sites are untouched", async () => {
  await saveOverride("x", "a", "keep", 1);
  await saveOverride("x", "b", "confirmed", 2);
  await saveOverride("instagram", "a", "confirmed", 3);
  await saveOverride("x", "a", "confirmed", 4);

  expect(await loadOverrides("x")).toStrictEqual({
    entries: { a: { decision: "confirmed", at: 4 }, b: { decision: "confirmed", at: 2 } }
  });
  expect(await loadOverrides("instagram")).toStrictEqual({ entries: { a: { decision: "confirmed", at: 3 } } });
  expect(await loadOverrides("youtube")).toStrictEqual(emptyOverrides());
});

test("concurrent answers never lose one another", async () => {
  await Promise.all([
    saveOverride("x", "a", "keep", 1),
    saveOverride("x", "b", "keep", 2),
    saveOverride("x", "c", "confirmed", 3)
  ]);
  expect(Object.keys((await loadOverrides("x")).entries).sort()).toEqual(["a", "b", "c"]);
});

test("an override survives a simulated reload and never expires with the daily cache", async () => {
  await saveOverride("x", "k", "keep", 10);
  store[sigKey("x")] = { day: today(), providerKey: "openai:gpt-6-luna:1", entries: { k: { ad: 0.9, suggested: null } }, order: ["k"] };
  delete store[sigKey("x")];
  const reloaded = await loadOverrides("x");
  expect(lookupOverride(reloaded, "k")).toStrictEqual({ decision: "keep", at: 10 });
  expect(JSON.stringify(store[overrideKey("x")])).not.toContain("day");
  expect(JSON.stringify(store[overrideKey("x")])).not.toContain("providerKey");
});

test("normalizeOverrides keeps valid entries and drops every malformed one", () => {
  expect(normalizeOverrides(undefined)).toStrictEqual(emptyOverrides());
  expect(normalizeOverrides("junk")).toStrictEqual(emptyOverrides());
  expect(normalizeOverrides({ entries: [] })).toStrictEqual(emptyOverrides());
  expect(
    normalizeOverrides({
      day: "2026-10-30",
      entries: {
        good: { decision: "keep", at: 5 },
        alsoGood: { decision: "confirmed", at: 0 },
        unknownDecision: { decision: "maybe", at: 5 },
        noAt: { decision: "keep" },
        badAt: { decision: "keep", at: Number.NaN },
        notAnObject: "keep",
        negative: { decision: "keep", at: -1 }
      }
    })
  ).toStrictEqual({ entries: { good: { decision: "keep", at: 5 }, alsoGood: { decision: "confirmed", at: 0 } } });
  expect(lookupOverride(undefined, "good")).toBeUndefined();
});

test("clearOverride removes one answer and clearOverrides removes every site's answers", async () => {
  await saveOverride("x", "a", "keep", 1);
  await saveOverride("x", "b", "keep", 2);
  await saveOverride("linkedin", "c", "confirmed", 3);

  await clearOverride("x", "a");
  expect(Object.keys((await loadOverrides("x")).entries)).toEqual(["b"]);
  await clearOverride("x", "missing");
  expect(Object.keys((await loadOverrides("x")).entries)).toEqual(["b"]);

  await clearOverrides(SITE_IDS);
  expect(await loadOverrides("x")).toStrictEqual(emptyOverrides());
  expect(await loadOverrides("linkedin")).toStrictEqual(emptyOverrides());
  expect(Object.keys(store).filter((k) => k.startsWith("override:"))).toEqual([]);
});

test("a user keep clears that key's over-cap charge and leaves the other keys named", async () => {
  await recordOverCap("x", ["poisoned", "other"]);
  expect((await loadOverCap("x")).sort()).toEqual(["other", "poisoned"]);
  await clearOverCap("x", "poisoned");
  expect(await loadOverCap("x")).toEqual(["other"]);
  await clearOverCap("x", "other");
  expect(await loadOverCap("x")).toEqual([]);
  await clearOverCap("x", "already-gone");
  expect(await loadOverCap("x")).toEqual([]);
  expect(networkCalls).toBe(0);
});
