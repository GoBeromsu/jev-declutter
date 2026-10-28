import type { Action, Category, ProviderId, Settings, SiteId } from "./types";

const SITE_IDS: SiteId[] = ["youtube", "x", "instagram", "linkedin"];
const CATEGORIES: Category[] = ["ad", "suggested", "module"];
const PROVIDERS: ProviderId[] = ["openai", "typesafe"];
const ACTIONS: Action[] = ["keep", "blur", "hide"];

export const DEFAULT_SETTINGS: Settings = {
  provider: "openai",
  openai: { apiKey: "", model: "gpt-6-luna" },
  typesafe: { apiKey: "", model: "jev-latest" },
  sites: {
    youtube: { enabled: true },
    x: { enabled: true },
    instagram: { enabled: true },
    linkedin: { enabled: true }
  },
  actions: { ad: "hide", suggested: "hide", module: "hide" }
};

export const sigKey = (site: SiteId): string => `sig:${site}`;

export const budgetKey = (day: string): string => `budget:${day}`;

type Unknown = Record<string, unknown>;

const isRecord = (v: unknown): v is Unknown => typeof v === "object" && v !== null && !Array.isArray(v);

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const mergeProvider = (
  saved: unknown,
  fallback: Settings["openai"]
): Settings["openai"] => {
  const raw = isRecord(saved) ? saved : {};
  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : fallback.apiKey,
    model: typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : fallback.model
  };
};

function normalizeSettings(saved: unknown): Settings {
  const raw: Unknown = isRecord(saved) ? saved : {};
  const sitesRaw = isRecord(raw.sites) ? raw.sites : {};
  const actionsRaw = isRecord(raw.actions) ? raw.actions : {};
  const sites = {} as Settings["sites"];
  for (const id of SITE_IDS) {
    const entry = sitesRaw[id];
    sites[id] = { enabled: isRecord(entry) ? entry.enabled !== false : DEFAULT_SETTINGS.sites[id].enabled };
  }
  const actions = {} as Settings["actions"];
  for (const category of CATEGORIES) {
    actions[category] = pick(actionsRaw[category], ACTIONS, DEFAULT_SETTINGS.actions[category]);
  }
  return {
    provider: pick(raw.provider, PROVIDERS, DEFAULT_SETTINGS.provider),
    openai: mergeProvider(raw.openai, DEFAULT_SETTINGS.openai),
    typesafe: mergeProvider(raw.typesafe, DEFAULT_SETTINGS.typesafe),
    sites,
    actions
  };
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}
