import { today } from "./decide";
import { QUESTION_VERSION } from "./providers/common";
import { budgetKey, sigKey } from "./storage";
import type { Settings, SignatureCache, SignatureVerdict, SiteId } from "./types";

export const DAILY_REQUEST_BUDGET = 300;
export const PER_MINUTE_CAP = 30;
export const MAX_ITEMS = 20;

const DEFAULT_CAP = 2000;
const MINUTE_MS = 60_000;

export function providerKey(s: Settings): string {
  const model = s.provider === "openai" ? s.openai.model : s.typesafe.model;
  return `${s.provider}:${model}:${QUESTION_VERSION}`;
}

export function freshCache(day: string, key: string): SignatureCache {
  return { day, providerKey: key, entries: {}, order: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const scoreOf = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined;

function verdictOf(v: unknown): SignatureVerdict | undefined {
  if (!isRecord(v)) return undefined;
  const ad = scoreOf(v.ad);
  const suggested = scoreOf(v.suggested);
  return ad === undefined || suggested === undefined ? undefined : { ad, suggested };
}

function orderOf(c: Record<string, unknown>, entries: Record<string, SignatureVerdict>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(c.order)) {
    for (const k of c.order) {
      if (typeof k === "string" && !seen.has(k) && Object.hasOwn(entries, k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  for (const k of Object.keys(entries)) {
    if (!seen.has(k)) out.push(k);
  }
  return out;
}

function isTracked(c: Record<string, unknown>, order: string[]): boolean {
  return (
    Array.isArray(c.order) &&
    c.order.length === order.length &&
    c.order.every((k, i) => k === order[i])
  );
}

export function ensureCurrent(c: SignatureCache | undefined, day: string, key: string): SignatureCache {
  if (!isRecord(c) || c.day !== day || c.providerKey !== key || !isRecord(c.entries) || !Array.isArray(c.order)) {
    return freshCache(day, key);
  }
  const entries: Record<string, SignatureVerdict> = {};
  for (const [k, v] of Object.entries(c.entries)) {
    const verdict = verdictOf(v);
    if (verdict) entries[k] = verdict;
  }
  const order = orderOf(c, entries);
  const intact = Object.keys(entries).length === Object.keys(c.entries).length && isTracked(c, order);
  return intact ? c : { day, providerKey: key, entries, order };
}

export function remember(
  c: SignatureCache | undefined,
  entries: Record<string, SignatureVerdict>,
  cap = DEFAULT_CAP
): SignatureCache {
  const base = c && isRecord(c) && isRecord(c.entries) ? c : freshCache(c?.day ?? "", c?.providerKey ?? "");
  const merged: Record<string, SignatureVerdict> = { ...base.entries };
  const order = orderOf(base as unknown as Record<string, unknown>, merged);
  for (const [k, v] of Object.entries(entries)) {
    if (!Object.hasOwn(merged, k)) order.push(k);
    merged[k] = v;
  }
  const excess = cap <= 0 ? order.length : order.length - cap;
  for (const k of order.splice(0, Math.max(0, excess))) delete merged[k];
  return { day: base.day, providerKey: base.providerKey, entries: merged, order };
}

export function lookup(c: SignatureCache | undefined, key: string): SignatureVerdict | undefined {
  if (!c || !isRecord(c.entries)) return undefined;
  const v = c.entries[key];
  return verdictOf(v);
}

export interface BudgetState {
  day: string;
  count: number;
  minute: number;
  minuteCount: number;
}

const minuteOf = (now: Date): number => Math.floor(now.getTime() / MINUTE_MS);

function readState(state: unknown, day: string, minute: number): BudgetState | undefined {
  if (!isRecord(state) || state.day !== day) return undefined;
  const count = finite(state.count);
  const storedMinute = finite(state.minute);
  const minuteCount = finite(state.minuteCount);
  if (count === undefined || storedMinute === undefined || minuteCount === undefined) return undefined;
  if (count < 0 || minuteCount < 0 || count > DAILY_REQUEST_BUDGET) return undefined;
  return {
    day,
    count,
    minute,
    minuteCount: storedMinute === minute ? Math.min(minuteCount, PER_MINUTE_CAP) : 0
  };
}

export function tryConsume(state: BudgetState | undefined, now: Date): { ok: boolean; next: BudgetState } {
  const day = today(now);
  const minute = minuteOf(now);
  const current = readState(state, day, minute);
  const base: BudgetState = current ?? { day, count: 0, minute, minuteCount: 0 };
  if (base.count >= DAILY_REQUEST_BUDGET || base.minuteCount >= PER_MINUTE_CAP) {
    return { ok: false, next: base };
  }
  return {
    ok: true,
    next: { day, count: base.count + 1, minute, minuteCount: base.minuteCount + 1 }
  };
}

export async function loadSigCache(site: SiteId): Promise<SignatureCache | undefined> {
  const key = sigKey(site);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return isRecord(value) ? (value as unknown as SignatureCache) : undefined;
}

export async function saveSigCache(site: SiteId, c: SignatureCache): Promise<void> {
  await chrome.storage.local.set({ [sigKey(site)]: c });
}

let queue: Promise<unknown> = Promise.resolve();

export function consumeBudget(day: string, now: Date = new Date()): Promise<{ ok: boolean; next: BudgetState }> {
  const run = queue.then(async () => {
    const key = budgetKey(day);
    const stored = await chrome.storage.local.get(key);
    const result = tryConsume(stored[key] as BudgetState | undefined, now);
    await chrome.storage.local.set({ [key]: result.next });
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}
