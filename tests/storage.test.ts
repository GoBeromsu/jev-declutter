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
  expect(DEFAULT_SETTINGS.hideAds).toBe(true);
  expect(DEFAULT_SETTINGS.hideSuggested).toBe(true);
});

test("partial saved settings are deep-merged over the defaults", async () => {
  store.settings = { provider: "typesafe" };
  const s = await loadSettings();
  expect(s.provider).toBe("typesafe");
  expect(s.hideSuggested).toBe(true);
  expect(s.sites.youtube).toEqual({ enabled: true });
});

test("legacy per-category actions map onto the one recommendations switch", async () => {
  store.settings = { actions: { ad: "keep", suggested: "keep", module: "hide" } };
  expect((await loadSettings()).hideSuggested).toBe(false);
  store.settings = { actions: { suggested: "blur" } };
  expect((await loadSettings()).hideSuggested).toBe(true);
  store.settings = { hideSuggested: false, actions: { suggested: "hide" } };
  expect((await loadSettings()).hideSuggested).toBe(false);
});

test("the ads switch is stored on its own and defaults on", async () => {
  store.settings = { hideAds: false };
  expect((await loadSettings()).hideAds).toBe(false);
  store.settings = { hideAds: "no" };
  expect((await loadSettings()).hideAds).toBe(true);
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
