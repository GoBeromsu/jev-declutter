import { consumeBudget, ensureCurrent, loadSigCache, MAX_ITEMS, OVER_CAP_PREFIX, providerKey, remember, saveSigCache } from "./cache";
import { today } from "./decide";
import { providerFor } from "./providers/index";
import { ProviderError } from "./providers/common";
import { budgetKey, loadSettings } from "./storage";
import type {
  ClassifyResult,
  DecisionProvider,
  ItemDescriptor,
  ItemScores,
  Message,
  ProviderId,
  Settings,
  SignatureVerdict,
  SiteId
} from "./types";

export { MAX_ITEMS };
export const PAUSE_MS = 60_000;
export const PAUSE_KEY = "pauseUntil";

type ClassifyMessage = Extract<Message, { type: "classify" }>;

type Verdicts = { ok: true; byKey: Map<string, ItemScores> } | { ok: false; error: string };

const PROVIDER_IDS: readonly ProviderId[] = ["openai", "typesafe"];

export interface ClassifyDeps {
  loadSettings: () => Promise<Settings>;
  consumeBudget: (day: string, now: Date) => Promise<{ ok: boolean }>;
  providerFor: (id: ProviderId) => DecisionProvider;
  now: () => Date;
}

const defaultDeps: ClassifyDeps = { loadSettings, consumeBudget, providerFor, now: () => new Date() };

const NO_SCORE: ItemScores = { ad: null, suggested: null };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const scoreOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const hasValidKey = (it: unknown): it is ItemDescriptor =>
  isRecord(it) && typeof it.key === "string" && it.key !== "";

// loadSettings() normalizes an unknown provider id to the default. Silently sending the user's feed to a
// provider they did not choose is worse than failing open (plan D1/D3: the user explicitly picks the
// provider), so a provider field that is present but unknown is rejected here. An absent field still
// means the default provider.
async function storedProviderIsUnknown(): Promise<boolean> {
  const { settings } = await chrome.storage.local.get("settings");
  if (!isRecord(settings) || !Object.hasOwn(settings, "provider")) return false;
  return !(PROVIDER_IDS as readonly unknown[]).includes(settings.provider);
}

async function pausedUntil(): Promise<number> {
  const stored = await chrome.storage.local.get(PAUSE_KEY);
  const until = stored[PAUSE_KEY];
  return typeof until === "number" && Number.isFinite(until) ? until : 0;
}

function normalizeScores(raw: unknown, count: number): ItemScores[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.scores)) return undefined;
  const scores = raw.scores as unknown[];
  return Array.from({ length: count }, (_, i) => {
    const s = scores[i];
    return isRecord(s) ? { ad: scoreOf(s.ad), suggested: scoreOf(s.suggested) } : { ...NO_SCORE };
  });
}

let cacheWrites: Promise<unknown> = Promise.resolve();

function storeVerdicts(site: SiteId, settings: Settings, day: string, byKey: Map<string, ItemScores>) {
  const entries: Record<string, SignatureVerdict> = Object.fromEntries(byKey);
  const run = cacheWrites.then(async () => {
    const current = ensureCurrent(await loadSigCache(site), day, providerKey(settings));
    await saveSigCache(site, remember(current, entries));
  });
  cacheWrites = run.catch(() => undefined);
  return run;
}

async function classify(site: SiteId, items: ItemDescriptor[], deps: ClassifyDeps): Promise<Verdicts> {
  if (items.length === 0) return { ok: true, byKey: new Map() };
  const settings = await deps.loadSettings();
  const siteSettings = Object.hasOwn(settings.sites, site) ? settings.sites[site] : undefined;
  if (!siteSettings?.enabled) return fail("disabled");

  if (await storedProviderIsUnknown()) {
    console.warn("[jev-declutter]", site, "unsupported stored provider");
    return fail("provider");
  }
  let provider: DecisionProvider;
  try {
    provider = deps.providerFor(settings.provider);
  } catch (e) {
    console.warn("[jev-declutter]", site, e instanceof Error ? e.message : String(e));
    return fail("provider");
  }
  const { apiKey, model } = settings[settings.provider];
  if (!apiKey) return fail("no-key");

  const now = deps.now();
  if ((await pausedUntil()) > now.getTime()) return fail("paused");
  const day = today(now);
  if (!(await deps.consumeBudget(day, now)).ok) return fail("budget");

  const batch = items.slice(0, MAX_ITEMS);
  if (items.length > MAX_ITEMS) console.warn("[jev-declutter]", site, "over-cap items kept", items.length - MAX_ITEMS);
  let raw: unknown;
  try {
    raw = await provider.classify(site, batch, apiKey, model);
  } catch (e) {
    if (e instanceof ProviderError) {
      console.warn("[jev-declutter]", site, e.message);
      if (e.status === 429 || e.status >= 500) {
        await chrome.storage.local.set({ [PAUSE_KEY]: now.getTime() + PAUSE_MS });
      }
      return fail(`http-${e.status}`);
    }
    console.warn("[jev-declutter]", site, "network", e instanceof Error ? e.message : String(e));
    return fail("network");
  }

  const scores = normalizeScores(raw, batch.length);
  if (!scores) {
    console.warn("[jev-declutter]", site, "malformed provider answer");
    return fail("malformed");
  }
  const byKey = new Map<string, ItemScores>();
  batch.forEach((it, i) => byKey.set(it.key, scores[i] ?? { ...NO_SCORE }));
  await storeVerdicts(site, settings, day, byKey);
  return { ok: true, byKey };
}

const inflight = new Map<string, Promise<Verdicts>>();

function verdictsFor(site: SiteId, items: ItemDescriptor[], deps: ClassifyDeps): Promise<Verdicts> {
  const coalesceKey = JSON.stringify([site, ...items.map((it) => it.key).sort()]);
  const running = inflight.get(coalesceKey);
  if (running) return running;
  const job = classify(site, items, deps)
    .catch((e: unknown): Verdicts => {
      console.warn("[jev-declutter]", site, e instanceof Error ? e.message : String(e));
      return fail("internal");
    })
    .finally(() => inflight.delete(coalesceKey));
  inflight.set(coalesceKey, job);
  return job;
}

/** Never rejects: every failure becomes `{ ok: false }` so the page fails open. */
export async function handleClassify(msg: ClassifyMessage, deps: ClassifyDeps = defaultDeps): Promise<ClassifyResult> {
  try {
    if (!isRecord(msg) || typeof msg.site !== "string" || !Array.isArray(msg.items)) return fail("bad-request");
    const items: unknown[] = msg.items;
    const verdicts = await verdictsFor(msg.site, items.filter(hasValidKey), deps);
    if (!verdicts.ok) return verdicts;
    return {
      ok: true,
      scores: items.map((it) => ({ ...((hasValidKey(it) && verdicts.byKey.get(it.key)) || NO_SCORE) }))
    };
  } catch (e) {
    console.warn("[jev-declutter]", "classify failed", e instanceof Error ? e.message : String(e));
    return fail("internal");
  }
}

async function sigKeys(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith("sig:"));
}

export async function resetCaches(now: Date = new Date()): Promise<void> {
  // An over-cap note names a cached signature, so clearing the cache must clear the note too -
  // otherwise the options page keeps pointing at a verdict that no longer exists.
  const stored = Object.keys(await chrome.storage.local.get(null));
  const stale = stored.filter((k) => k.startsWith("sig:") || k.startsWith(OVER_CAP_PREFIX));
  await chrome.storage.local.remove([...stale, budgetKey(today(now))]);
}

function activeModel(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.provider !== "string") return "";
  const entry = Object.hasOwn(raw, raw.provider) ? raw[raw.provider] : undefined;
  const model = isRecord(entry) ? entry.model : undefined;
  return `${raw.provider}:${typeof model === "string" ? model : ""}`;
}

/** Registers every listener; call synchronously at service-worker start so wake-up events are not missed. */
export function startBackground(): void {
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
}

function onMessage(msg: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): boolean {
  if (!isRecord(msg)) return false;
  if (msg.type === "classify") {
    handleClassify(msg as ClassifyMessage).then(sendResponse);
    return true;
  }
  if (msg.type === "reset") {
    resetCaches().then(
      () => sendResponse({ ok: true }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
    );
    return true;
  }
  return false;
}

export async function handleStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
): Promise<void> {
  if (area !== "local" || !changes.settings) return;
  const { oldValue, newValue } = changes.settings;
  if (activeModel(oldValue) === activeModel(newValue)) return;
  try {
    await chrome.storage.local.remove(await sigKeys());
  } catch (e) {
    console.warn("[jev-declutter]", "cache clear failed", e);
  }
}

