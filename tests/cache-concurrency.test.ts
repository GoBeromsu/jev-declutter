import { beforeEach, expect, test } from "bun:test";
import { consumeBudget } from "../src/cache";
import { today } from "../src/decide";
import { budgetKey } from "../src/storage";

const store: Record<string, unknown> = {};

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (key: string) => {
          await later();
          return key in store ? { [key]: clone(store[key]) } : {};
        },
        set: async (values: Record<string, unknown>) => {
          await later();
          Object.assign(store, clone(values));
        }
      }
    }
  }
});

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

const now = new Date(2026, 9, 28, 12, 0);
const minute = Math.floor(now.getTime() / 60_000);

test("a storage stub that defers every read still grants only one of four at count=299", async () => {
  const key = budgetKey("2026-10-28");
  store[key] = { day: today(now), count: 299, minute, minuteCount: 4 };
  const results = await Promise.all(Array.from({ length: 4 }, () => consumeBudget(today(now), now)));
  expect(results.map((r) => r.ok)).toEqual([true, false, false, false]);
  expect(store[key]).toEqual({ day: today(now), count: 300, minute, minuteCount: 5 });
});

test("a storage stub that defers every read still grants only one of four at minuteCount=29", async () => {
  const key = budgetKey("2026-10-28");
  store[key] = { day: today(now), count: 40, minute, minuteCount: 29 };
  const results = await Promise.all(Array.from({ length: 4 }, () => consumeBudget(today(now), now)));
  expect(results.map((r) => r.ok)).toEqual([true, false, false, false]);
  expect(store[key]).toEqual({ day: today(now), count: 41, minute, minuteCount: 30 });
});
