import { beforeEach, expect, test } from "bun:test";
import { DAILY_REQUEST_BUDGET, overCapKey } from "../src/cache";
import { today } from "../src/decide";
import { collectForm, main, populateForm, renderDiagnostics, renderOverrides } from "../src/options";
import { overrideKey } from "../src/overrides";
import { DEFAULT_TYPESAFE_MODEL } from "../src/providers/typesafe";
import { DEFAULT_SETTINGS, budgetKey, sigKey } from "../src/storage";
import type { Settings, SiteId } from "../src/types";

const HTML = await Bun.file(`${import.meta.dir}/../entrypoints/options/index.html`).text();

const SITES: SiteId[] = ["youtube", "x", "instagram", "linkedin"];

const store: Record<string, unknown> = {};
const sent: unknown[] = [];
const recordMessage = async (msg: unknown): Promise<unknown> => {
  sent.push(msg);
  return undefined;
};
let sendMessage: (msg: unknown) => Promise<unknown> = recordMessage;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: clone(store[key]) } : {}),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, clone(values));
        },
        remove: async (keys: string | string[]) => {
          for (const key of typeof keys === "string" ? [keys] : keys) delete store[key];
        }
      }
    },
    runtime: { sendMessage: (msg: unknown) => sendMessage(msg) }
  }
});

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  sent.length = 0;
  sendMessage = recordMessage;
});

const page = (): Document => new DOMParser().parseFromString(HTML, "text/html");

const $ = <T extends Element>(doc: Document, id: string): T => {
  const el = doc.querySelector<T>(`#${id}`);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const input = (doc: Document, id: string) => $<HTMLInputElement>(doc, id);
const select = (doc: Document, id: string) => $<HTMLSelectElement>(doc, id);
const rowsOf = (doc: Document, site: SiteId) => Array.from($(doc, `diag-${site}`).querySelectorAll("tbody tr"));
const cells = (row: Element | undefined) => Array.from(row?.querySelectorAll("td") ?? []).map((td) => td.textContent?.trim() ?? "");

const nextState = (doc: Document, trigger: () => void, timeoutMs = 2000): Promise<string> =>
  new Promise((resolve, reject) => {
    const status = $<HTMLElement>(doc, "status");
    const observer = new MutationObserver(() => {
      const state = status.dataset.state;
      if (!state) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(state);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("status data-state never changed"));
    }, timeoutMs);
    observer.observe(status, { attributes: true, attributeFilter: ["data-state"] });
    trigger();
  });

const FULL: Settings = {
  provider: "typesafe",
  openai: { apiKey: "sk-openai", model: "gpt-6-luna-mini" },
  typesafe: { apiKey: "ts-key", model: "jev-1.14.0" },
  sites: {
    youtube: { enabled: true },
    x: { enabled: false },
    instagram: { enabled: true },
    linkedin: { enabled: false }
  },
  hideAds: false,
  hideSuggested: false
};

const cacheOf = (day: string, providerKey: string, entries: Record<string, unknown>, order: unknown = Object.keys(entries)) => ({
  day,
  providerKey,
  entries,
  order
});

const AT = Date.parse("2026-10-30T09:00:00");
const overrideRows = (doc: Document, site: SiteId) =>
  Array.from($(doc, `override-${site}`).querySelectorAll("tbody tr"));

test("markup: lang=ko, masked key fields, no remote assets, no free-text goal fields", () => {
  const doc = page();
  expect(doc.documentElement.getAttribute("lang")).toBe("ko");
  for (const id of ["openai-key", "typesafe-key"]) {
    expect(input(doc, id).type).toBe("password");
    expect(input(doc, id).getAttribute("autocomplete")).toBe("off");
  }
  expect(doc.querySelectorAll("textarea").length).toBe(0);
  expect(Array.from(doc.querySelectorAll("script")).map((s) => s.getAttribute("src"))).toEqual(["../../src/options.ts"]);
  expect(doc.querySelectorAll("link, iframe, img, video, audio, object, embed").length).toBe(0);
  expect(HTML).not.toMatch(/https?:\/\//);
  expect(HTML).not.toMatch(/@import/);
  expect(HTML).not.toMatch(/url\(/);
  expect(Array.from(select(doc, "model").options).map((o) => o.value)).toEqual(["openai:gpt-6-luna", "typesafe:jev-latest"]);
  for (const site of SITES) {
    expect(input(doc, `site-${site}`).type).toBe("checkbox");
    expect(input(doc, `site-${site}`).closest("label")?.textContent?.trim()).not.toBe("");
  }
  expect(input(doc, "hide-suggested").type).toBe("checkbox");
  expect(doc.querySelectorAll('[id^="action-"]').length).toBe(0);
});

test("the untouched page collects to DEFAULT_SETTINGS", () => {
  expect(collectForm(page())).toStrictEqual(DEFAULT_SETTINGS);
});

test("collectForm maps every control into an exact Settings object", () => {
  const doc = page();
  populateForm({ ...DEFAULT_SETTINGS, openai: { apiKey: "", model: "gpt-6-luna-mini" }, typesafe: { apiKey: "", model: "jev-1.14.0" } }, doc);
  select(doc, "model").value = "typesafe:jev-1.14.0";
  input(doc, "openai-key").value = "  sk-openai  ";
  input(doc, "typesafe-key").value = "ts-key";
  input(doc, "site-youtube").checked = true;
  input(doc, "site-x").checked = false;
  input(doc, "site-instagram").checked = true;
  input(doc, "site-linkedin").checked = false;
  input(doc, "hide-ads").checked = false;
  input(doc, "hide-suggested").checked = false;

  const collected = collectForm(doc);
  expect(collected).toStrictEqual(FULL);
  expect(Object.keys(collected).sort()).toEqual(["hideAds", "hideSuggested", "openai", "provider", "sites", "typesafe"]);
  expect(Object.keys(collected.sites)).toEqual(SITES);
});

test("the model dropdown picks the provider; a missing model falls back to that provider's default", () => {
  const doc = page();
  select(doc, "model").value = "typesafe:jev-latest";
  expect(collectForm(doc).provider).toBe("typesafe");
  const forced = doc.createElement("option");
  forced.value = "bogus";
  select(doc, "model").append(forced);
  select(doc, "model").value = "bogus";
  const s = collectForm(doc);
  expect(s.provider).toBe(DEFAULT_SETTINGS.provider);
  expect(s.openai.model).toBe(DEFAULT_SETTINGS.openai.model);
  expect(s.typesafe.model).toBe(DEFAULT_TYPESAFE_MODEL);
});

test("populateForm then collectForm round-trips a full Settings object, keeping unlisted saved models", () => {
  const doc = page();
  populateForm(FULL, doc);
  expect(select(doc, "model").value).toBe("typesafe:jev-1.14.0");
  expect(input(doc, "openai-key").value).toBe("sk-openai");
  expect(input(doc, "site-x").checked).toBe(false);
  expect(input(doc, "hide-suggested").checked).toBe(false);
  expect(collectForm(doc)).toStrictEqual(FULL);

  populateForm(DEFAULT_SETTINGS, doc);
  expect(select(doc, "model").value).toBe("openai:gpt-6-luna");
  expect(collectForm(doc)).toStrictEqual(DEFAULT_SETTINGS);
});

test("renderDiagnostics: one row per signalKey, '-' for null, two decimals, day, providerKey and budget", () => {
  const doc = page();
  const cache = cacheOf("2026-10-28", "openai:gpt-6-luna:1", {
    k1: { ad: 0.9, suggested: null },
    k2: { ad: 0.123, suggested: 0.5 },
    k3: { ad: null, suggested: null }
  });
  renderDiagnostics({ day: "2026-10-28", currentKey: "openai:gpt-6-luna:1", caches: { youtube: cache }, budgetUsed: 7 }, doc);

  const yt = $<HTMLElement>(doc, "diag-youtube");
  const rows = rowsOf(doc, "youtube");
  expect(rows.length).toBe(3);
  expect(cells(rows[0])).toEqual(["k1", "0.90", "-"]);
  expect(cells(rows[1])).toEqual(["k2", "0.12", "0.50"]);
  expect(cells(rows[2])).toEqual(["k3", "-", "-"]);
  expect(yt.dataset.rows).toBe("3");
  expect(yt.dataset.day).toBe("2026-10-28");
  expect(yt.dataset.providerKey).toBe("openai:gpt-6-luna:1");
  expect(yt.dataset.stale).toBe("false");
  expect(yt.textContent).toContain("2026-10-28");
  expect(yt.textContent).toContain("openai:gpt-6-luna:1");

  for (const site of ["x", "instagram", "linkedin"] as const) {
    expect(rowsOf(doc, site).length).toBe(0);
    expect($<HTMLElement>(doc, `diag-${site}`).dataset.rows).toBe("0");
  }
  expect($(doc, "diagnostics").querySelectorAll("section").length).toBe(4);

  const budget = $<HTMLElement>(doc, "budget");
  expect(budget.dataset.used).toBe("7");
  expect(budget.dataset.limit).toBe(String(DAILY_REQUEST_BUDGET));
  expect(budget.textContent).toContain("7");
  expect(budget.textContent).toContain(String(DAILY_REQUEST_BUDGET));
});

test("renderDiagnostics follows the cache's own order and appends entries missing from it", () => {
  const doc = page();
  const cache = cacheOf("2026-10-28", "k", { a: { ad: 0, suggested: 1 }, b: { ad: 1, suggested: 0 }, c: { ad: 0.5, suggested: 0.5 } }, ["c", "a", "gone", "c"]);
  renderDiagnostics({ day: "2026-10-28", currentKey: "k", caches: { linkedin: cache }, budgetUsed: 0 }, doc);
  expect(rowsOf(doc, "linkedin").map((r) => cells(r)[0])).toEqual(["c", "a", "b"]);
  expect(cells(rowsOf(doc, "linkedin")[0])).toEqual(["c", "0.50", "0.50"]);
  expect(cells(rowsOf(doc, "linkedin")[1])).toEqual(["a", "0.00", "1.00"]);
});

test("stale_state: a cache with another providerKey or day still renders, labelled with its own values", () => {
  const doc = page();
  const cache = cacheOf("2026-10-27", "typesafe:jev-latest:1", { a: { ad: 1, suggested: 0 } });
  renderDiagnostics({ day: "2026-10-28", currentKey: "openai:gpt-6-luna:1", caches: { x: cache }, budgetUsed: 0 }, doc);
  const x = $<HTMLElement>(doc, "diag-x");
  expect(x.dataset.providerKey).toBe("typesafe:jev-latest:1");
  expect(x.dataset.day).toBe("2026-10-27");
  expect(x.dataset.stale).toBe("true");
  expect(cells(rowsOf(doc, "x")[0])).toEqual(["a", "1.00", "0.00"]);
  expect(x.textContent).toContain("typesafe:jev-latest:1");
});

test("malformed input: broken caches and a malformed budget render without throwing", () => {
  const doc = page();
  const linkedin = cacheOf(
    "2026-10-28",
    "k",
    { good: { ad: 0.5, suggested: 0.25 }, bad1: "x", bad2: { ad: "high", suggested: null }, bad3: null, bad4: { ad: Number.NaN, suggested: Number.POSITIVE_INFINITY } },
    5
  );
  renderDiagnostics(
    { day: "2026-10-28", currentKey: "k", caches: { youtube: 42, x: "junk", instagram: null, linkedin }, budgetUsed: Number.NaN },
    doc
  );
  expect(rowsOf(doc, "linkedin").map((r) => cells(r))).toEqual([
    ["good", "0.50", "0.25"],
    ["bad1", "-", "-"],
    ["bad2", "-", "-"],
    ["bad3", "-", "-"],
    ["bad4", "-", "-"]
  ]);
  for (const site of ["youtube", "x", "instagram"] as const) expect(rowsOf(doc, site).length).toBe(0);
  expect($<HTMLElement>(doc, "budget").dataset.used).toBe("0");

  const shapeless = cacheOf("2026-10-28", "k", {}, []);
  renderDiagnostics({ day: "2026-10-28", currentKey: "k", caches: { youtube: { day: 7 }, x: { entries: [] }, instagram: shapeless }, budgetUsed: -3 }, doc);
  for (const site of SITES) expect(rowsOf(doc, site).length).toBe(0);
  expect($<HTMLElement>(doc, "budget").dataset.used).toBe("0");
});

test("main(): partial, legacy and garbage stored settings populate the form from defaults without throwing", async () => {
  const cases: [unknown, Settings][] = [
    [undefined, DEFAULT_SETTINGS],
    [42, DEFAULT_SETTINGS],
    [null, DEFAULT_SETTINGS],
    ["nope", DEFAULT_SETTINGS],
    [{ apiKey: "sk-old", model: "jev-latest", goals: { youtube: "less noise" } }, DEFAULT_SETTINGS],
    [
      { provider: "typesafe", sites: { x: { enabled: false } }, actions: { suggested: "keep" } },
      { ...DEFAULT_SETTINGS, provider: "typesafe", sites: { ...DEFAULT_SETTINGS.sites, x: { enabled: false } }, hideSuggested: false }
    ]
  ];
  for (const [stored, expected] of cases) {
    for (const key of Object.keys(store)) delete store[key];
    if (stored !== undefined) store.settings = stored;
    store[sigKey("x")] = cacheOf("2026-10-28", "k", { ok: { ad: 0.9, suggested: null }, broken: "x" }, "not-an-array");
    store[sigKey("linkedin")] = "junk";
    store[budgetKey(today())] = { day: today(), count: "7" };
    const doc = page();
    await main(doc);
    expect(collectForm(doc)).toStrictEqual(expected);
    expect(select(doc, "model").value.startsWith(`${expected.provider}:`)).toBe(true);
    expect(rowsOf(doc, "x").map((r) => cells(r))).toEqual([
      ["ok", "0.90", "-"],
      ["broken", "-", "-"]
    ]);
    expect(rowsOf(doc, "linkedin").length).toBe(0);
    expect($<HTMLElement>(doc, "budget").dataset.used).toBe("0");
  }
});

test("over-cap signatures are marked on their own row and only while still cached", () => {
  const doc = page();
  const cache = cacheOf("2026-10-28", "k", { shared: { ad: 0.95, suggested: null }, other: { ad: 0.1, suggested: 0.1 } });
  renderDiagnostics(
    { day: "2026-10-28", currentKey: "k", caches: { x: cache }, budgetUsed: 0, overCap: { x: ["shared", "cleared"] } },
    doc
  );
  const x = $<HTMLElement>(doc, "diag-x");
  const rows = rowsOf(doc, "x");
  expect(x.dataset.overCap).toBe("1");
  expect(rows.map((r) => (r as HTMLElement).dataset.overCap)).toEqual(["true", undefined]);
  expect(cells(rows[0])[0]).toContain("shared");
  expect(x.textContent).toContain("그룹 상한");
  expect($<HTMLElement>(doc, "diag-youtube").dataset.overCap).toBe("0");
  expect($<HTMLElement>(doc, "diag-youtube").textContent).not.toContain("그룹 상한");
});

test("main(): an over-cap record for today is read from storage and a stale one is ignored", async () => {
  const day = today();
  store[sigKey("x")] = cacheOf(day, "openai:gpt-6-luna:1", { poisoned: { ad: 0.95, suggested: null } });
  store[overCapKey("x")] = { day, keys: ["poisoned"] };
  store[sigKey("youtube")] = cacheOf(day, "openai:gpt-6-luna:1", { yesterday: { ad: 0.95, suggested: null } });
  store[overCapKey("youtube")] = { day: "2000-01-01", keys: ["yesterday"] };
  store[overCapKey("linkedin")] = "junk";
  const doc = page();
  await main(doc);
  expect($<HTMLElement>(doc, "diag-x").dataset.overCap).toBe("1");
  expect((rowsOf(doc, "x")[0] as HTMLElement).dataset.overCap).toBe("true");
  expect($<HTMLElement>(doc, "diag-youtube").dataset.overCap).toBe("0");
  expect($<HTMLElement>(doc, "diag-linkedin").dataset.overCap).toBe("0");
});

test("main(): today's budget count and each site's cache are read from storage under the landed keys", async () => {
  const day = today();
  store.settings = { provider: "typesafe" };
  store[budgetKey(day)] = { day, count: 12, minute: 0, minuteCount: 3 };
  store[budgetKey("2000-01-01")] = { day: "2000-01-01", count: 299, minute: 0, minuteCount: 0 };
  store[sigKey("youtube")] = cacheOf(day, "typesafe:jev-latest:1", { yt: { ad: 0.8, suggested: 0.2 } });
  store[sigKey("instagram")] = cacheOf(day, "openai:gpt-6-luna:1", { ig: { ad: null, suggested: 0.75 } });
  const doc = page();
  await main(doc);
  expect($<HTMLElement>(doc, "budget").dataset.used).toBe("12");
  expect($<HTMLElement>(doc, "diag-youtube").dataset.stale).toBe("false");
  expect($<HTMLElement>(doc, "diag-instagram").dataset.stale).toBe("true");
  expect(cells(rowsOf(doc, "youtube")[0])).toEqual(["yt", "0.80", "0.20"]);
  expect(cells(rowsOf(doc, "instagram")[0])).toEqual(["ig", "-", "0.75"]);
});

test("submitting the form saves the collected Settings under 'settings' and re-renders", async () => {
  store.settings = { provider: "openai" };
  const doc = page();
  await main(doc);
  populateForm(FULL, doc);

  const state = await nextState(doc, () => {
    $<HTMLFormElement>(doc, "settings").dispatchEvent(new Event("submit", { cancelable: true }));
  });
  expect(state).toBe("saved");
  expect(store.settings).toStrictEqual(FULL);
  expect(select(doc, "model").value).toBe("typesafe:jev-1.14.0");
  expect(sent).toEqual([]);
  expect($<HTMLElement>(doc, "diag-youtube").dataset.stale).toBe("false");
});

test("the cache button sends { type: 'reset' } and re-renders the diagnostics afterwards", async () => {
  const day = today();
  store[sigKey("x")] = cacheOf(day, "openai:gpt-6-luna:1", { a: { ad: 1, suggested: 1 } });
  sendMessage = async (msg) => {
    sent.push(msg);
    for (const site of SITES) delete store[sigKey(site)];
    return undefined;
  };
  const doc = page();
  await main(doc);
  expect(rowsOf(doc, "x").length).toBe(1);

  const state = await nextState(doc, () => $<HTMLButtonElement>(doc, "reset").click());
  expect(state).toBe("reset");
  expect(sent).toEqual([{ type: "reset" }]);
  expect(rowsOf(doc, "x").length).toBe(0);
  expect(store.settings).toBeUndefined();
});

test("a failed reset message surfaces as an error state instead of an unhandled rejection", async () => {
  sendMessage = async () => {
    throw new Error("no background");
  };
  const doc = page();
  await main(doc);
  const state = await nextState(doc, () => $<HTMLButtonElement>(doc, "reset").click());
  expect(state).toBe("error");
  expect($<HTMLElement>(doc, "status").textContent).toContain("no background");
});

test("renderOverrides lists the count and one row per opaque key with its decision", () => {
  const doc = page();
  renderOverrides(
    {
      x: { entries: { k1: { decision: "keep", at: AT }, k2: { decision: "confirmed", at: AT } } },
      youtube: { entries: {} },
      linkedin: { entries: { k3: { decision: "keep", at: AT } } }
    },
    doc
  );

  expect($<HTMLElement>(doc, "override-summary").dataset.count).toBe("3");
  expect($<HTMLElement>(doc, "override-summary").textContent).toContain("3");
  expect($<HTMLElement>(doc, "override-x").dataset.count).toBe("2");
  expect(overrideRows(doc, "x").map((r) => (r as HTMLElement).dataset.decision)).toEqual(["keep", "confirmed"]);
  expect(cells(overrideRows(doc, "x")[0]).slice(0, 3)).toEqual(["k1", "광고 아님", today(new Date(AT))]);
  expect(cells(overrideRows(doc, "x")[1]).slice(0, 3)).toEqual(["k2", "광고 맞음", today(new Date(AT))]);
  expect(overrideRows(doc, "linkedin").length).toBe(1);
  expect(doc.querySelector("#override-youtube")).toBeNull();
  expect(doc.querySelector("#override-instagram")).toBeNull();
  const button = overrideRows(doc, "x")[0]?.querySelector<HTMLButtonElement>("button[data-key]");
  expect(button?.dataset.site).toBe("x");
  expect(button?.dataset.key).toBe("k1");
});

test("renderOverrides shows an empty state and no rows when nothing was answered", () => {
  const doc = page();
  renderOverrides({ x: { entries: {} } }, doc);
  expect($<HTMLElement>(doc, "override-summary").dataset.count).toBe("0");
  expect($<HTMLElement>(doc, "overrides").querySelectorAll("tr").length).toBe(0);
  expect($<HTMLElement>(doc, "overrides").textContent).toContain("아직");
});

test("main renders stored answers and a row's clear button removes exactly that answer", async () => {
  store[overrideKey("x")] = { entries: { keep1: { decision: "keep", at: AT }, keep2: { decision: "confirmed", at: AT } } };
  store[overrideKey("instagram")] = { entries: { other: { decision: "keep", at: AT } } };
  const doc = page();
  await main(doc);
  expect($<HTMLElement>(doc, "override-summary").dataset.count).toBe("3");

  const button = overrideRows(doc, "x")[0]?.querySelector<HTMLButtonElement>("button[data-key]");
  const state = await nextState(doc, () => button?.click());
  expect(state).toBe("reset");
  expect(store[overrideKey("x")]).toStrictEqual({ entries: { keep2: { decision: "confirmed", at: AT } } });
  expect(store[overrideKey("instagram")]).toStrictEqual({ entries: { other: { decision: "keep", at: AT } } });
  expect($<HTMLElement>(doc, "override-summary").dataset.count).toBe("2");
});

test("the clear-all button removes every site's answers and leaves the caches alone", async () => {
  const day = today();
  store[overrideKey("x")] = { entries: { a: { decision: "keep", at: AT } } };
  store[overrideKey("youtube")] = { entries: { b: { decision: "confirmed", at: AT } } };
  store[sigKey("x")] = cacheOf(day, "openai:gpt-6-luna:1", { a: { ad: 1, suggested: 1 } });
  const doc = page();
  await main(doc);
  expect($<HTMLElement>(doc, "override-summary").dataset.count).toBe("2");

  const state = await nextState(doc, () => $<HTMLButtonElement>(doc, "override-clear-all").click());
  expect(state).toBe("reset");
  expect($<HTMLElement>(doc, "override-summary").dataset.count).toBe("0");
  expect(Object.keys(store).filter((k) => k.startsWith("override:"))).toEqual([]);
  expect(store[sigKey("x")]).toBeDefined();
  expect(sent).toEqual([]);
});

test("a malformed stored answer record never reaches the list", async () => {
  store[overrideKey("x")] = { entries: { good: { decision: "keep", at: AT }, bad: { decision: "whatever", at: AT } } };
  store[overrideKey("linkedin")] = "junk";
  const doc = page();
  await main(doc);
  expect($<HTMLElement>(doc, "override-summary").dataset.count).toBe("1");
  expect(overrideRows(doc, "x").map((r) => cells(r)[0] ?? "")).toEqual(["good"]);
  expect(doc.querySelector("#override-linkedin")).toBeNull();
});
