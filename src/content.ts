import { loadSigCache } from "./cache";
import { startScanner } from "./scan";
import { SITES, siteForHost } from "./sites";
import { loadSettings, sigKey } from "./storage";

export function startContent(): void {
  const site = siteForHost(location.hostname);
  if (site) {
    const scanner = startScanner(SITES[site]);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("settings" in changes) void loadSettings().then(scanner.nextSettings).catch(() => undefined);
      if (sigKey(site) in changes) void loadSigCache(site).then(scanner.updateCache).catch(() => undefined);
    });
  }
}
