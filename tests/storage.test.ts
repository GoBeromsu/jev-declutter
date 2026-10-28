import { beforeEach, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, budgetKey, loadSettings, sigKey } from "../src/storage";

const store: Record<string, unknown> = {};

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        }
      }
    }
  }
});

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

test("empty storage returns the defaults", async () => {
  expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
});

test("defaults match the plan", () => {
  expect(DEFAULT_SETTINGS.provider).toBe("openai");
  expect(DEFAULT_SETTINGS.openai.model).toBe("gpt-6-luna");
  expect(DEFAULT_SETTINGS.typesafe.model).toBe("jev-latest");
  expect(DEFAULT_SETTINGS.sites).toEqual({
    youtube: { enabled: true },
    x: { enabled: true },
    instagram: { enabled: true },
    linkedin: { enabled: true }
  });
  expect(DEFAULT_SETTINGS.actions).toEqual({ ad: "hide", suggested: "hide", module: "hide" });
});

test("partial saved settings are deep-merged over the defaults", async () => {
  store.settings = { provider: "typesafe", actions: { ad: "blur" } };
  const s = await loadSettings();
  expect(s.provider).toBe("typesafe");
  expect(s.actions).toEqual({ ad: "blur", suggested: "hide", module: "hide" });
  expect(s.sites.youtube).toEqual({ enabled: true });
});

test("a missing site keeps its default enabled state", async () => {
  store.settings = { sites: { youtube: { enabled: false } } };
  const s = await loadSettings();
  expect(s.sites.youtube).toEqual({ enabled: false });
  expect(s.sites.linkedin).toEqual({ enabled: true });
});

test("legacy apiKey/model/goals settings yield defaults without throwing", async () => {
  store.settings = { apiKey: "sk-old", model: "jev-latest", goals: { youtube: "less noise" } };
  const s = await loadSettings();
  expect(s).toEqual(DEFAULT_SETTINGS);
  expect("apiKey" in s).toBe(false);
  expect("goals" in s).toBe(false);
});

test("garbage saved settings yield defaults without throwing", async () => {
  for (const garbage of [42, null, "nope", [], { provider: "bogus", actions: 7, sites: null }]) {
    store.settings = garbage;
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  }
});

test("legacy keys stored next to settings are ignored", async () => {
  store.settings = { provider: "typesafe" };
  store.apiKey = "sk-old";
  store.model = "jev-0";
  const s = await loadSettings();
  expect(s.provider).toBe("typesafe");
  expect(s.openai.apiKey).toBe("");
  expect(s.typesafe.apiKey).toBe("");
});

test("storage keys are per site and per day", () => {
  expect(sigKey("x")).toBe("sig:x");
  expect(sigKey("linkedin")).toBe("sig:linkedin");
  expect(budgetKey("2026-01-05")).toBe("budget:2026-01-05");
});
