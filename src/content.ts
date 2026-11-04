import { loadSigCache } from "./cache";
import { startScanner } from "./scan";
import { SITES, siteForHost } from "./sites";
import { loadSettings, sigKey } from "./storage";
import type { SiteId } from "./types";

declare global {
  var __JEV_QA_ENABLE__: boolean | undefined;
  var __JEV_QA_SITE__: SiteId | undefined;
  var __JEV_QA__: ReturnType<typeof startScanner>["qa"] | undefined;
}

export function startContent(): void {
  const override = globalThis.__JEV_QA_ENABLE__ === true ? globalThis.__JEV_QA_SITE__ : undefined;
  const site = override && Object.hasOwn(SITES, override) ? override : siteForHost(location.hostname);
  if (site) {
    const scanner = startScanner(SITES[site]);
    if (globalThis.__JEV_QA_ENABLE__ === true) globalThis.__JEV_QA__ = scanner.qa;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("settings" in changes) void loadSettings().then(scanner.nextSettings).catch(() => undefined);
      if (sigKey(site) in changes) void loadSigCache(site).then(scanner.updateCache).catch(() => undefined);
    });
  }
}
