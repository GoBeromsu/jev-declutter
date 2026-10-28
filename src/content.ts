import { today } from "./decide";
import { SITES, siteForHost } from "./sites";
import { cacheKey, loadCache } from "./storage";
import type { Candidate, Message, SiteCache, SiteId } from "./types";

const SAMPLE_CHARS = 160;
// SPAs render their chrome late; snapshot once the page has had time to settle.
const SETTLE_MS = 4000;

const style = document.createElement("style");
style.id = "jev-declutter";

function apply(css: string) {
  style.textContent = css;
  if (!style.isConnected) (document.head ?? document.documentElement).appendChild(style);
}

function isValidSelector(selector: string): boolean {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function sampleOf(el: Element | null): string | undefined {
  const text = el?.textContent?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, SAMPLE_CHARS) : undefined;
}

function collectCandidates(site: SiteId): Candidate[] {
  const config = SITES[site];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const seed of config.seeds) {
    if (!isValidSelector(seed.selector)) continue;
    seen.add(seed.selector);
    out.push({ ...seed, sample: sampleOf(document.querySelector(seed.selector)), source: "seed" });
  }
  for (const el of document.querySelectorAll(config.discover)) {
    const label = el.getAttribute("aria-label");
    if (!label) continue;
    const selector = `${el.tagName.toLowerCase()}[aria-label=${JSON.stringify(label)}]`;
    if (seen.has(selector) || !isValidSelector(selector)) continue;
    seen.add(selector);
    out.push({ selector, description: `Page region labelled "${label}"`, sample: sampleOf(el), source: "discovered" });
  }
  return out;
}

function scheduleSnapshot(site: SiteId) {
  const send = () => {
    const msg: Message = { type: "snapshot", site, candidates: collectCandidates(site) };
    chrome.runtime.sendMessage(msg);
  };
  const later = () => setTimeout(send, SETTLE_MS);
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });
}

const site = siteForHost(location.hostname);
if (site) {
  const key = cacheKey(site);
  loadCache(site).then((cache) => {
    if (cache) apply(cache.css);
    if (!cache || cache.day !== today()) scheduleSnapshot(site);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(key in changes)) return;
    const next = changes[key]!.newValue as SiteCache | undefined;
    apply(next?.css ?? "");
  });
}
