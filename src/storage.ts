import { SITES } from "./sites";
import type { Settings, SiteCache, SiteId } from "./types";

export const cacheKey = (site: SiteId) => `cache:${site}`;

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "jev-latest",
  goals: {
    youtube: SITES.youtube.defaultGoal,
    x: SITES.x.defaultGoal,
    instagram: SITES.instagram.defaultGoal
  }
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const saved = (settings ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...saved, goals: { ...DEFAULT_SETTINGS.goals, ...saved.goals } };
}

export async function loadCache(site: SiteId): Promise<SiteCache | undefined> {
  const key = cacheKey(site);
  const stored = await chrome.storage.local.get(key);
  return stored[key] as SiteCache | undefined;
}
