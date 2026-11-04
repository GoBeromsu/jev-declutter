import type { ProviderId, Settings, SiteId } from "./types";

const SITE_IDS: SiteId[] = ["youtube", "x", "instagram", "linkedin"];
const PROVIDERS: ProviderId[] = ["openai", "typesafe"];

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
  hideAds: true,
  hideSuggested: true
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
  const sites = {} as Settings["sites"];
  for (const id of SITE_IDS) {
    const entry = sitesRaw[id];
    sites[id] = { enabled: isRecord(entry) ? entry.enabled !== false : DEFAULT_SETTINGS.sites[id].enabled };
  }
  const legacy = isRecord(raw.actions) ? raw.actions.suggested : undefined;
  const hideSuggested = typeof raw.hideSuggested === "boolean" ? raw.hideSuggested : legacy !== "keep";
  const hideAds = typeof raw.hideAds === "boolean" ? raw.hideAds : true;
  return {
    provider: pick(raw.provider, PROVIDERS, DEFAULT_SETTINGS.provider),
    openai: mergeProvider(raw.openai, DEFAULT_SETTINGS.openai),
    typesafe: mergeProvider(raw.typesafe, DEFAULT_SETTINGS.typesafe),
    sites,
    hideAds,
    hideSuggested
  };
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}
