import { decide, renderCss, today } from "./decide";
import { askJev } from "./jev";
import { cacheKey, loadCache, loadSettings } from "./storage";
import type { Candidate, Decision, Message, RefreshResult, SiteCache, SiteId } from "./types";

const MAX_CANDIDATES = 40;
const inflight = new Map<SiteId, Promise<RefreshResult>>();

async function refresh(site: SiteId, candidates: Candidate[]): Promise<RefreshResult> {
  const cached = await loadCache(site);
  if (cached && cached.day === today()) return { ok: true, status: "fresh", cache: cached };

  const settings = await loadSettings();
  if (!settings.apiKey) return { ok: false, error: "No TypeSafe API key. Set it on the options page." };

  const picked = candidates.slice(0, MAX_CANDIDATES);
  const { model, scores } = await askJev(settings.apiKey, settings.model, site, settings.goals[site], picked);
  const decisions: Decision[] = picked.map((c, i) => {
    const s = scores[i]!;
    return { selector: c.selector, description: c.description, ...s, action: decide(s.distracting, s.essential) };
  });
  const cache: SiteCache = { day: today(), site, model, decisions, css: renderCss(decisions) };
  await chrome.storage.local.set({ [cacheKey(site)]: cache });
  return { ok: true, status: "refreshed", cache };
}

function refreshOnce(site: SiteId, candidates: Candidate[]): Promise<RefreshResult> {
  const running = inflight.get(site);
  if (running) return running;
  const job = refresh(site, candidates)
    .catch((e: unknown): RefreshResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => inflight.delete(site));
  inflight.set(site, job);
  return job;
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type === "snapshot") {
    refreshOnce(msg.site, msg.candidates).then((result) => {
      if (!result.ok) console.warn("[jev-declutter]", msg.site, result.error);
      sendResponse(result);
    });
    return true;
  }
  if (msg.type === "reset") {
    chrome.storage.local.remove([cacheKey("youtube"), cacheKey("x"), cacheKey("instagram")]).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
