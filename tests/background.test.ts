import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { consumeBudget, overCapKey } from "../src/cache";
import { today } from "../src/decide";
import { ProviderError } from "../src/providers/common";
import { DEFAULT_SETTINGS, budgetKey, sigKey } from "../src/storage";
import type { ClassifyResult, DecisionProvider, ItemDescriptor, ItemScores, Message, ProviderId, Settings } from "../src/types";

type Listener = (...args: unknown[]) => unknown;

const store: Record<string, unknown> = {};
const listeners: { message: Listener[]; clicked: Listener[]; changed: Listener[] } = { message: [], clicked: [], changed: [] };
let openedOptions = 0;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (key: string | null) => {
          if (key === null) return clone(store);
          return Object.hasOwn(store, key) ? { [key]: clone(store[key]) } : {};
        },
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, clone(values));
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        }
      },
      onChanged: { addListener: (fn: Listener) => listeners.changed.push(fn) }
    },
    runtime: {
      onMessage: { addListener: (fn: Listener) => listeners.message.push(fn) },
      openOptionsPage: () => {
        openedOptions += 1;
      }
    },
    action: { onClicked: { addListener: (fn: Listener) => listeners.clicked.push(fn) } }
  }
});

type Background = typeof import("../src/background");
type Cache = typeof import("../src/cache");
const restartWorker = async (): Promise<{ bg: Background; cache: Cache }> => {
  delete require.cache[require.resolve("../src/cache.ts")];
  delete require.cache[require.resolve("../src/background.ts")];
  const cache = (await import("../src/cache")) as Cache;
  const bg = (await import("../src/background")) as Background;
  bg.startBackground();
  return { bg, cache };
};

const bg: Background = await import("../src/background");
bg.startBackground();

const NOW = new Date(2026, 9, 28, 12, 0, 0);

const item = (n: number, key = `k${n}`): ItemDescriptor => ({
  n,
  key,
  signature: `sig${n}`,
  chrome_text: ["Promoted"],
  has_follow_button: false,
  has_external_link: false,
  ad_attribute: false,
  media: "none",
  path_kind: "home"
});

const classifyMsg = (items: ItemDescriptor[], site: "x" | "youtube" = "x") =>
  ({ type: "classify", site, items }) as Extract<Message, { type: "classify" }>;

const settingsWith = (patch: Partial<Settings> = {}): Settings => ({
  ...clone(DEFAULT_SETTINGS),
  openai: { apiKey: "sk-test", model: "gpt-6-luna" },
  ...patch
});

interface FakeProvider extends DecisionProvider {
  calls: number;
}

const fakeProvider = (impl: (items: ItemDescriptor[]) => Promise<{ model: string; scores: ItemScores[] }>): FakeProvider => {
  const p: FakeProvider = {
    id: "openai",
    calls: 0,
    classify: async (_site, items) => {
      p.calls += 1;
      return impl(items);
    }
  };
  return p;
};

const scoring = () =>
  fakeProvider(async (items) => ({ model: "gpt-6-luna", scores: items.map((_, i) => ({ ad: i % 2 ? 0.9 : 0.1, suggested: 0.2 })) }));

const keyed = (table: Record<string, ItemScores>) =>
  fakeProvider(async (items) => ({ model: "m", scores: items.map((it) => table[it.key] ?? { ad: null, suggested: null }) }));

const gated = (table: Record<string, ItemScores>) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = fakeProvider(async (items) => {
    await gate;
    return { model: "m", scores: items.map((it) => table[it.key] ?? { ad: null, suggested: null }) };
  });
  return { provider, release };
};

const depsFor = (
  provider: DecisionProvider,
  opts: { settings?: Settings; now?: () => Date; budgetOk?: boolean; consume?: Cache["consumeBudget"] } = {}
) => ({
  loadSettings: async () => opts.settings ?? settingsWith(),
  consumeBudget:
    opts.budgetOk === undefined
      ? (day: string, now: Date) => (opts.consume ?? consumeBudget)(day, now)
      : async () => ({ ok: opts.budgetOk as boolean }),
  providerFor: (_id: ProviderId) => provider,
  now: opts.now ?? (() => NOW)
});

let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

test("success returns the scores and caches every item key under the site", async () => {
  const provider = scoring();
  const items = [item(0), item(1), item(2)];
  const result = await bg.handleClassify(classifyMsg(items), depsFor(provider));
  expect(result).toEqual({
    ok: true,
    scores: [
      { ad: 0.1, suggested: 0.2 },
      { ad: 0.9, suggested: 0.2 },
      { ad: 0.1, suggested: 0.2 }
    ]
  });
  const cache = store[sigKey("x")] as { day: string; entries: Record<string, unknown> };
  expect(cache.day).toBe(today(NOW));
  expect(Object.keys(cache.entries).sort()).toEqual(["k0", "k1", "k2"]);
  expect(cache.entries).not.toHaveProperty("sig0");
  expect(provider.calls).toBe(1);
});

test("no key -> no-key and the provider is never called", async () => {
  const provider = scoring();
  const result = await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider, { settings: clone(DEFAULT_SETTINGS) }));
  expect(result).toEqual({ ok: false, error: "no-key" });
  expect(provider.calls).toBe(0);
});

test("the key is read from the selected provider only", async () => {
  const provider = scoring();
  const settings = settingsWith({ provider: "typesafe" });
  const result = await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider, { settings }));
  expect(result).toEqual({ ok: false, error: "no-key" });
  expect(provider.calls).toBe(0);
});

test("a disabled site -> disabled and the provider is never called", async () => {
  const provider = scoring();
  const settings = settingsWith();
  settings.sites.x.enabled = false;
  const result = await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider, { settings }));
  expect(result).toEqual({ ok: false, error: "disabled" });
  expect(provider.calls).toBe(0);
});

test("an unknown site id is treated as disabled", async () => {
  const provider = scoring();
  const msg = { type: "classify", site: "__proto__", items: [item(0)] } as unknown as Extract<Message, { type: "classify" }>;
  expect(await bg.handleClassify(msg, depsFor(provider))).toEqual({ ok: false, error: "disabled" });
  expect(provider.calls).toBe(0);
});

test("budget denied -> budget and the provider is never called", async () => {
  const provider = scoring();
  const result = await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider, { budgetOk: false }));
  expect(result).toEqual({ ok: false, error: "budget" });
  expect(provider.calls).toBe(0);
});

test("an exhausted stored daily budget -> budget", async () => {
  store[budgetKey(today(NOW))] = { day: today(NOW), count: 300, minute: 0, minuteCount: 0 };
  const provider = scoring();
  expect(await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).toEqual({ ok: false, error: "budget" });
  expect(provider.calls).toBe(0);
});

test("a persisted pause in effect -> paused, no provider call, no budget spent", async () => {
  store.pauseUntil = NOW.getTime() + 30_000;
  const provider = scoring();
  expect(await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).toEqual({ ok: false, error: "paused" });
  expect(provider.calls).toBe(0);
  expect(store[budgetKey(today(NOW))]).toBeUndefined();
});

test("an expired pause no longer blocks", async () => {
  store.pauseUntil = NOW.getTime() - 1;
  const provider = scoring();
  expect((await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).ok).toBe(true);
});

test("a corrupt stored pause value is ignored", async () => {
  store.pauseUntil = "tomorrow";
  const provider = scoring();
  expect((await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).ok).toBe(true);
});

test("429 -> http-429, one warn, a persisted 60s pause, and the next call is paused without the provider", async () => {
  const provider = fakeProvider(async () => {
    throw new ProviderError(429, "slow down");
  });
  expect(await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).toEqual({ ok: false, error: "http-429" });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toBe("[jev-declutter]");
  expect(store.pauseUntil).toBe(NOW.getTime() + 60_000);
  const later = () => new Date(NOW.getTime() + 59_000);
  expect(await bg.handleClassify(classifyMsg([item(1)]), depsFor(provider, { now: later }))).toEqual({ ok: false, error: "paused" });
  expect(provider.calls).toBe(1);
  const after = () => new Date(NOW.getTime() + 60_000);
  await bg.handleClassify(classifyMsg([item(2)]), depsFor(provider, { now: after }));
  expect(provider.calls).toBe(2);
});

test("5xx pauses, 401 does not", async () => {
  const p500 = fakeProvider(async () => {
    throw new ProviderError(503, "down");
  });
  expect(await bg.handleClassify(classifyMsg([item(0)]), depsFor(p500))).toEqual({ ok: false, error: "http-503" });
  expect(store.pauseUntil).toBe(NOW.getTime() + 60_000);
  delete store.pauseUntil;
  const p401 = fakeProvider(async () => {
    throw new ProviderError(401, "bad key");
  });
  expect(await bg.handleClassify(classifyMsg([item(1)]), depsFor(p401))).toEqual({ ok: false, error: "http-401" });
  expect(store.pauseUntil).toBeUndefined();
});

test("a TypeError from fetch while offline -> network, nothing cached", async () => {
  const provider = fakeProvider(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).toEqual({ ok: false, error: "network" });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(store[sigKey("x")]).toBeUndefined();
  expect(store.pauseUntil).toBeUndefined();
});

test("fail-open matrix: no throw escapes handleClassify", async () => {
  const cases: Array<() => Promise<{ model: string; scores: ItemScores[] }>> = [
    async () => {
      throw new ProviderError(401, "x");
    },
    async () => {
      throw new ProviderError(429, "x");
    },
    async () => {
      throw new ProviderError(500, "x");
    },
    async () => {
      throw new TypeError("offline");
    },
    async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
    async () => ({ model: "m", scores: [{ ad: null, suggested: null }] }),
    async () => ({ model: "m", scores: "garbage" }) as unknown as { model: string; scores: ItemScores[] },
    async () => null as unknown as { model: string; scores: ItemScores[] },
    async () => ({ model: "m", scores: [{ ad: "high", suggested: Number.NaN }] }) as unknown as { model: string; scores: ItemScores[] }
  ];
  for (const impl of cases) {
    delete store.pauseUntil;
    const result: ClassifyResult = await bg.handleClassify(classifyMsg([item(0)]), depsFor(fakeProvider(impl)));
    if (result.ok) {
      expect(result.scores).toHaveLength(1);
      for (const s of result.scores) {
        expect(s.ad === null || (typeof s.ad === "number" && Number.isFinite(s.ad))).toBe(true);
        expect(s.suggested === null || (typeof s.suggested === "number" && Number.isFinite(s.suggested))).toBe(true);
      }
    } else {
      expect(typeof result.error).toBe("string");
    }
  }
});

test("refusal-only answer -> ok with null scores (keep)", async () => {
  const provider = fakeProvider(async () => ({ model: "m", scores: [{ ad: null, suggested: null }] }));
  expect(await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).toEqual({
    ok: true,
    scores: [{ ad: null, suggested: null }]
  });
});

test("a short score array pads missing items with null", async () => {
  const provider = fakeProvider(async () => ({ model: "m", scores: [{ ad: 0.9, suggested: 0.1 }] }));
  expect(await bg.handleClassify(classifyMsg([item(0), item(1)]), depsFor(provider))).toEqual({
    ok: true,
    scores: [
      { ad: 0.9, suggested: 0.1 },
      { ad: null, suggested: null }
    ]
  });
});

const AD: ItemScores = { ad: 0.95, suggested: 0.05 };
const ORGANIC: ItemScores = { ad: 0.05, suggested: 0.95 };
const THIRD: ItemScores = { ad: 0.5, suggested: 0.5 };

test("two reordered concurrent calls call the provider once and each gets scores in ITS own item order", async () => {
  const { provider, release } = gated({ k0: AD, k1: ORGANIC });
  const deps = depsFor(provider);
  const a = bg.handleClassify(classifyMsg([item(0), item(1)]), deps);
  const b = bg.handleClassify(classifyMsg([item(1), item(0)]), deps);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(provider.calls).toBe(1);
  expect(ra).toEqual({ ok: true, scores: [AD, ORGANIC] });
  expect(rb).toEqual({ ok: true, scores: [ORGANIC, AD] });
  expect((store[budgetKey(today(NOW))] as { count: number }).count).toBe(1);
});

test("concurrent calls sharing only some keys are not coalesced and each gets its own per-key scores", async () => {
  const { provider, release } = gated({ k0: AD, k1: ORGANIC, k2: THIRD });
  const deps = depsFor(provider);
  const a = bg.handleClassify(classifyMsg([item(0), item(1)]), deps);
  const b = bg.handleClassify(classifyMsg([item(1), item(2)]), deps);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(provider.calls).toBe(2);
  expect(ra).toEqual({ ok: true, scores: [AD, ORGANIC] });
  expect(rb).toEqual({ ok: true, scores: [ORGANIC, THIRD] });
});

test("keys containing the separator cannot forge a coalescing collision", async () => {
  const { provider, release } = gated({ a: AD, "b\nc": ORGANIC, "a\nb": THIRD, c: AD });
  const deps = depsFor(provider);
  const a = bg.handleClassify(classifyMsg([item(0, "a"), item(1, "b\nc")]), deps);
  const b = bg.handleClassify(classifyMsg([item(0, "a\nb"), item(1, "c")]), deps);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(provider.calls).toBe(2);
  expect(ra).toEqual({ ok: true, scores: [AD, ORGANIC] });
  expect(rb).toEqual({ ok: true, scores: [THIRD, AD] });
  const cache = store[sigKey("x")] as { entries: Record<string, unknown> };
  expect(Object.keys(cache.entries).sort()).toEqual(["a", "a\nb", "b\nc", "c"]);
});

test("coalesced callers do not share mutable score objects", async () => {
  const { provider, release } = gated({ k0: AD });
  const deps = depsFor(provider);
  const a = bg.handleClassify(classifyMsg([item(0)]), deps);
  const b = bg.handleClassify(classifyMsg([item(0)]), deps);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  if (!ra.ok || !rb.ok) throw new Error("expected ok");
  expect(ra.scores[0]).not.toBe(rb.scores[0]);
});

const badKeys: Array<[string, unknown]> = [
  ["an object with a broken toString", { toString: 1 }],
  ["a number", 7],
  ["null", null],
  ["undefined", undefined],
  ["an empty string", ""]
];

for (const [label, bad] of badKeys) {
  test(`an item key that is ${label} gets a null score and does not take down the batch`, async () => {
    const provider = keyed({ k0: AD, k2: ORGANIC });
    const broken = { ...item(1), key: bad } as unknown as ItemDescriptor;
    const result = await bg.handleClassify(classifyMsg([item(0), broken, item(2)]), depsFor(provider));
    expect(result).toEqual({ ok: true, scores: [AD, { ad: null, suggested: null }, ORGANIC] });
    expect(provider.calls).toBe(1);
    const cache = store[sigKey("x")] as { entries: Record<string, unknown> };
    expect(Object.keys(cache.entries).sort()).toEqual(["k0", "k2"]);
  });
}

test("a batch whose only item has an invalid key is kept without a provider call", async () => {
  const provider = scoring();
  const broken = { ...item(0), key: { toString: 1 } } as unknown as ItemDescriptor;
  expect(await bg.handleClassify(classifyMsg([broken]), depsFor(provider))).toEqual({
    ok: true,
    scores: [{ ad: null, suggested: null }]
  });
  expect(provider.calls).toBe(0);
});

test("the same keys on a different site are not coalesced", async () => {
  const provider = scoring();
  const deps = depsFor(provider);
  await Promise.all([bg.handleClassify(classifyMsg([item(0)], "x"), deps), bg.handleClassify(classifyMsg([item(0)], "youtube"), deps)]);
  expect(provider.calls).toBe(2);
});

test("a finished batch is not coalesced with a later identical one", async () => {
  const provider = scoring();
  const deps = depsFor(provider);
  await bg.handleClassify(classifyMsg([item(0)]), deps);
  await bg.handleClassify(classifyMsg([item(0)]), deps);
  expect(provider.calls).toBe(2);
});

test("unsupported stored provider ids answer ok:false without throwing or calling anything", async () => {
  for (const id of ["not-a-provider", "__proto__"]) {
    const settings = settingsWith({ provider: id as ProviderId });
    let budgetCalls = 0;
    const deps = {
      ...depsFor(scoring(), { settings }),
      consumeBudget: async () => {
        budgetCalls += 1;
        return { ok: true };
      },
      providerFor: (await import("../src/providers/index")).providerFor
    };
    const result = await bg.handleClassify(classifyMsg([item(0)]), deps);
    expect(result).toEqual({ ok: false, error: "provider" });
    expect(budgetCalls).toBe(0);
  }
});

const sendViaListener = (msg: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    expect(lastOf(listeners.message)(msg, {}, resolve)).toBe(true);
  });

const withFakeFetch = async (run: () => Promise<unknown>) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const answers = [
      { type: "predicate", name: "i0_ad", probability: 0.9 },
      { type: "predicate", name: "i0_suggested", probability: 0.1 }
    ];
    return new Response(JSON.stringify({ model: "gpt-6-luna", answers }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
};

const storedOpenai = { apiKey: "sk-test", model: "gpt-6-luna" };

for (const [label, provider] of [
  ["'not-a-provider'", "not-a-provider"],
  ["'__proto__'", "__proto__"],
  ["a numeric value", 7]
] as Array<[string, unknown]>) {
  test(`production path: a stored provider of ${label} answers provider and never fetches`, async () => {
    store.settings = { provider, openai: storedOpenai };
    const { result, calls } = await withFakeFetch(() => sendViaListener(classifyMsg([item(0)])));
    expect(result).toEqual({ ok: false, error: "provider" });
    expect(calls).toBe(0);
  });
}

test("production path: an absent provider field falls back to the default and classifies", async () => {
  store.settings = { openai: storedOpenai };
  const { result, calls } = await withFakeFetch(() => sendViaListener(classifyMsg([item(0)])));
  expect(result).toEqual({ ok: true, scores: [{ ad: 0.9, suggested: 0.1 }] });
  expect(calls).toBe(1);
});

test("a throwing loadSettings still answers ok:false", async () => {
  const deps = {
    ...depsFor(scoring()),
    loadSettings: async (): Promise<Settings> => {
      throw new Error("storage gone");
    }
  };
  const result = await bg.handleClassify(classifyMsg([item(0)]), deps);
  expect(result.ok).toBe(false);
});

test("malformed input: missing items or a non-array -> bad-request; 0 items -> empty ok without a call", async () => {
  const provider = scoring();
  const deps = depsFor(provider);
  const noItems = { type: "classify", site: "x" } as unknown as Extract<Message, { type: "classify" }>;
  expect(await bg.handleClassify(noItems, deps)).toEqual({ ok: false, error: "bad-request" });
  const notArray = { type: "classify", site: "x", items: "x" } as unknown as Extract<Message, { type: "classify" }>;
  expect(await bg.handleClassify(notArray, deps)).toEqual({ ok: false, error: "bad-request" });
  expect(await bg.handleClassify(classifyMsg([]), deps)).toEqual({ ok: true, scores: [] });
  expect(provider.calls).toBe(0);
  expect(store[budgetKey(today(NOW))]).toBeUndefined();
});

test("a huge batch sends at most MAX_ITEMS and keeps the overflow with null scores", async () => {
  const seen: number[] = [];
  const provider = fakeProvider(async (items) => {
    seen.push(items.length);
    return { model: "m", scores: items.map(() => ({ ad: 0.9, suggested: 0.1 })) };
  });
  const items = Array.from({ length: 500 }, (_, i) => item(i));
  const result = await bg.handleClassify(classifyMsg(items), depsFor(provider));
  expect(seen).toEqual([bg.MAX_ITEMS]);
  if (!result.ok) throw new Error("expected ok");
  expect(result.scores).toHaveLength(500);
  expect(result.scores[bg.MAX_ITEMS - 1]).toEqual({ ad: 0.9, suggested: 0.1 });
  expect(result.scores[bg.MAX_ITEMS]).toEqual({ ad: null, suggested: null });
  const cache = store[sigKey("x")] as { entries: Record<string, unknown> };
  expect(Object.keys(cache.entries)).toHaveLength(bg.MAX_ITEMS);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toBe("[jev-declutter]");
  expect(warn.mock.calls[0]).toContain(500 - bg.MAX_ITEMS);
});

test("a batch within MAX_ITEMS emits no cap warning", async () => {
  await bg.handleClassify(classifyMsg(Array.from({ length: 20 }, (_, i) => item(i))), depsFor(scoring()));
  expect(warn).toHaveBeenCalledTimes(0);
});

test("a corrupt stored cache is replaced, not trusted", async () => {
  store[sigKey("x")] = { day: today(NOW), providerKey: "openai:gpt-6-luna:1", entries: "oops", order: 5 };
  const provider = scoring();
  expect((await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider))).ok).toBe(true);
  const cache = store[sigKey("x")] as { entries: Record<string, unknown> };
  expect(Object.keys(cache.entries)).toEqual(["k0"]);
});

test("a day rollover starts an empty cache", async () => {
  const provider = scoring();
  await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider));
  const tomorrow = new Date(2026, 9, 29, 0, 0, 1);
  await bg.handleClassify(classifyMsg([item(1)]), depsFor(provider, { now: () => tomorrow }));
  const cache = store[sigKey("x")] as { day: string; entries: Record<string, unknown> };
  expect(cache.day).toBe(today(tomorrow));
  expect(Object.keys(cache.entries)).toEqual(["k1"]);
});

test("budget and pause survive a simulated worker restart (module re-import, same storage)", async () => {
  const provider = scoring();
  await bg.handleClassify(classifyMsg([item(0)]), depsFor(provider));
  expect((store[budgetKey(today(NOW))] as { count: number }).count).toBe(1);
  const revived = await restartWorker();
  expect(revived.bg).not.toBe(bg);
  expect(revived.cache.consumeBudget).not.toBe(consumeBudget);
  await revived.bg.handleClassify(classifyMsg([item(1)]), depsFor(provider, { consume: revived.cache.consumeBudget }));
  expect((store[budgetKey(today(NOW))] as { count: number }).count).toBe(2);

  const failing = fakeProvider(async () => {
    throw new ProviderError(429, "x");
  });
  await revived.bg.handleClassify(classifyMsg([item(2)]), depsFor(failing, { consume: revived.cache.consumeBudget }));
  const again = await restartWorker();
  expect(again.cache.consumeBudget).not.toBe(revived.cache.consumeBudget);
  expect(
    await again.bg.handleClassify(classifyMsg([item(3)]), depsFor(provider, { consume: again.cache.consumeBudget }))
  ).toEqual({ ok: false, error: "paused" });
  expect(provider.calls).toBe(2);
});

const lastOf = (list: Listener[]): Listener => {
  const fn = list.at(-1);
  if (!fn) throw new Error("listener not registered");
  return fn;
};

test("onMessage returns true for classify and reset, false otherwise", async () => {
  const onMessage = lastOf(listeners.message);
  expect(onMessage({ type: "nope" }, {}, () => {})).toBe(false);
  expect(onMessage(undefined, {}, () => {})).toBe(false);
  const answered = new Promise<unknown>((resolve) => {
    expect(onMessage({ type: "classify", site: "x", items: [] }, {}, resolve)).toBe(true);
  });
  expect(await answered).toEqual({ ok: true, scores: [] });
});

test("resetCaches removes every sig:* key and the injected day's budget key only", async () => {
  store[sigKey("x")] = { a: 1 };
  store[sigKey("youtube")] = { a: 1 };
  store[budgetKey(today(NOW))] = { count: 3 };
  store[budgetKey("2000-01-01")] = { count: 3 };
  store.settings = { provider: "openai" };
  await bg.resetCaches(NOW);
  expect(Object.keys(store).sort()).toEqual([budgetKey("2000-01-01"), "settings"]);
});

test("resetCaches also removes every overcap:* key, whatever day it carries", async () => {
  store[sigKey("x")] = { a: 1 };
  store[overCapKey("x")] = { day: today(NOW), keys: ["1fd217c7"] };
  store[overCapKey("youtube")] = { day: "2000-01-01", keys: ["stale"] };
  store[budgetKey(today(NOW))] = { count: 3 };
  store.settings = { provider: "openai" };
  await bg.resetCaches(NOW);
  expect(Object.keys(store).sort()).toEqual(["settings"]);
});

test("resetCaches and a provider change both keep the user's answers", async () => {
  store[sigKey("x")] = { a: 1 };
  store["override:x"] = { entries: { "1fd217c7": { decision: "keep", at: 5 } } };
  store.settings = { provider: "openai", openai: { model: "gpt-6-luna" } };
  await bg.resetCaches(NOW);
  await bg.handleStorageChange(
    { settings: { oldValue: { provider: "openai", openai: { model: "a" } }, newValue: { provider: "openai", openai: { model: "b" } } } },
    "local"
  );
  expect(store["override:x"]).toStrictEqual({ entries: { "1fd217c7": { decision: "keep", at: 5 } } });
  expect(store[sigKey("x")]).toBeUndefined();
});

test("the reset message answers ok and clears sig:* keys", async () => {
  store[sigKey("x")] = { a: 1 };
  store.settings = { provider: "openai" };
  expect(await sendViaListener({ type: "reset" })).toEqual({ ok: true });
  expect(store[sigKey("x")]).toBeUndefined();
  expect(store.settings).toBeDefined();
});

test("action click opens the options page", () => {
  const before = openedOptions;
  lastOf(listeners.clicked)();
  expect(openedOptions).toBe(before + 1);
});

test("storage onChanged clears sig:* when the provider or active model changes, not on a key change", async () => {
  const onChanged = lastOf(listeners.changed);
  const base = { provider: "openai", openai: { apiKey: "a", model: "gpt-6-luna" }, typesafe: { apiKey: "", model: "jev-latest" } };
  const seed = () => {
    store[sigKey("x")] = { a: 1 };
    store[sigKey("linkedin")] = { a: 1 };
  };
  const change = (changes: unknown, area: string): Promise<unknown> => {
    const done = onChanged(changes, area);
    expect(done).toBeInstanceOf(Promise);
    return done as Promise<unknown>;
  };

  seed();
  await change({ settings: { oldValue: base, newValue: { ...base, openai: { apiKey: "b", model: "gpt-6-luna" } } } }, "local");
  expect(store[sigKey("x")]).toBeDefined();

  await change({ settings: { oldValue: base, newValue: { ...base, openai: { apiKey: "a", model: "gpt-7" } } } }, "local");
  expect(store[sigKey("x")]).toBeUndefined();
  expect(store[sigKey("linkedin")]).toBeUndefined();

  seed();
  await change({ settings: { oldValue: base, newValue: { ...base, provider: "typesafe" } } }, "local");
  expect(store[sigKey("x")]).toBeUndefined();

  seed();
  await change({ settings: { oldValue: base, newValue: { ...base, provider: "typesafe" } } }, "sync");
  await change({ other: { oldValue: 1, newValue: 2 } }, "local");
  expect(store[sigKey("x")]).toBeDefined();
});
