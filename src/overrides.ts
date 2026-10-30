import type { SiteId } from "./types";

/**
 * The user's own answer about one signalKey, taken from the overlay prompt on a model-blurred item.
 * "keep": not an ad - release every item of that skeleton. "confirmed": it is an ad - keep treating it.
 *
 * Precedence is deterministic > user override > cache/model (src/scan.ts): a deterministic signal is
 * per-item evidence that needs no confirmation, while an override replaces a model guess about a
 * skeleton and therefore also short-circuits the request for that key - answering costs no network
 * call, now or later.
 */
export type OverrideDecision = "keep" | "confirmed";

/** Stored per answer: nothing but the opaque signalKey, the decision and when it was given. */
export interface OverrideEntry {
  decision: OverrideDecision;
  /** Epoch ms, local clock. */
  at: number;
}

export interface OverrideMap {
  entries: Record<string, OverrideEntry>;
}

export const OVERRIDE_PREFIX = "override:";

export const overrideKey = (site: SiteId): string => `${OVERRIDE_PREFIX}${site}`;

export const emptyOverrides = (): OverrideMap => ({ entries: {} });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const decisionOf = (v: unknown): OverrideDecision | undefined =>
  v === "keep" || v === "confirmed" ? v : undefined;

function entryOf(value: unknown): OverrideEntry | undefined {
  if (!isRecord(value)) return undefined;
  const decision = decisionOf(value.decision);
  const at = value.at;
  if (decision === undefined || typeof at !== "number" || !Number.isFinite(at) || at < 0) return undefined;
  return { decision, at };
}

/**
 * No day and no providerKey: an answer is the user's verdict, not a cached model one, so nothing
 * here expires with the daily cache (`resetCaches` in src/background.ts only clears `sig:` and
 * `overcap:` keys). Unknown fields in a stored record are dropped rather than carried forward.
 */
export function normalizeOverrides(value: unknown): OverrideMap {
  if (!isRecord(value) || !isRecord(value.entries)) return emptyOverrides();
  const entries: Record<string, OverrideEntry> = {};
  for (const [key, raw] of Object.entries(value.entries)) {
    const entry = entryOf(raw);
    if (entry) entries[key] = entry;
  }
  return { entries };
}

export function lookupOverride(map: OverrideMap | undefined, key: string): OverrideEntry | undefined {
  if (!map || !isRecord(map.entries)) return undefined;
  return entryOf(map.entries[key]);
}

export async function loadOverrides(site: SiteId): Promise<OverrideMap> {
  const key = overrideKey(site);
  const stored = await chrome.storage.local.get(key);
  return normalizeOverrides(stored[key]);
}

let queue: Promise<unknown> = Promise.resolve();

/** Serializes read-modify-write, so two answers in the same tick cannot drop one another. */
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => undefined);
  return run;
}

export function saveOverride(
  site: SiteId,
  key: string,
  decision: OverrideDecision,
  at: number = Date.now()
): Promise<void> {
  return serialize(async () => {
    const current = await loadOverrides(site);
    const next: OverrideMap = { entries: { ...current.entries, [key]: { decision, at } } };
    await chrome.storage.local.set({ [overrideKey(site)]: next });
  });
}

export function clearOverride(site: SiteId, key: string): Promise<void> {
  return serialize(async () => {
    const current = await loadOverrides(site);
    if (!Object.hasOwn(current.entries, key)) return;
    const entries = { ...current.entries };
    delete entries[key];
    await chrome.storage.local.set({ [overrideKey(site)]: { entries } });
  });
}

export function clearOverrides(sites: readonly SiteId[]): Promise<void> {
  return serialize(async () => {
    await chrome.storage.local.remove(sites.map(overrideKey));
  });
}
