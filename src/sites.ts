import type { SiteId } from "./types";

export interface SiteModule {
  selector: string;
  description: string;
  paths?: RegExp;
  blur?: true;
}

export interface SiteConfig {
  id: SiteId;
  hosts: string[];
  item: string;
  adSelectors: string[];
  labelSlots: string;
  followSlot: string;
  followMeansSuggested: boolean;
  modules: SiteModule[];
  excludedPaths: RegExp[];
  feedPaths: RegExp[];
  navEvent?: string;
  bodyExclude: string;
  collapseHidden?: boolean;
}

export const SITES: Record<SiteId, SiteConfig> = {
  youtube: {
    id: "youtube",
    hosts: ["www.youtube.com"],
    item: "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer",
    adSelectors: ["ytd-ad-slot-renderer", "ytd-in-feed-ad-layout-renderer", "ytd-promoted-sparkles-web-renderer"],
    labelSlots: "#metadata-line, ytd-badge-supported-renderer",
    bodyExclude: "#video-title, #description-text, yt-formatted-string#description",
    followSlot: "",
    followMeansSuggested: false,
    modules: [
      { selector: "ytd-reel-shelf-renderer", description: "Shorts shelf in feeds and search results" },
      { selector: "ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])", description: "Shorts row on the home feed" },
      { selector: "ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model-v2)", description: "Shorts row on the home feed (lockup view model)" },
      { selector: "grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2)", description: "Shorts grid shelf" },
      { selector: 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer', description: "Algorithmic home feed grid of recommended videos" },
      { selector: "ytd-watch-next-secondary-results-renderer", description: "Recommended videos sidebar next to the video being watched" },
      { selector: ".ytp-endscreen-content", description: "Recommended videos grid shown when a video ends" },
      { selector: ".ytp-ce-element", description: "End-screen cards overlaid on the video player" },
      { selector: "ytd-merch-shelf-renderer", description: "Merchandise shelf under the video" },
      { selector: 'ytd-guide-entry-renderer:has(a[title="Shorts"])', description: "Shorts link in the left navigation" },
      { selector: 'ytd-mini-guide-entry-renderer[aria-label="Shorts"]', description: "Shorts link in the collapsed left navigation" }
    ],
    excludedPaths: [],
    feedPaths: [/^\/$/, /^\/results/, /^\/watch/, /^\/feed\//],
    navEvent: "yt-navigate-finish"
  },
  x: {
    id: "x",
    hosts: ["x.com", "twitter.com"],
    item: 'div[data-testid="cellInnerDiv"]',
    adSelectors: ['[data-testid="placementTracking"]', 'div[data-testid$="-impression-pixel"]'],
    labelSlots: '[data-testid="socialContext"], [data-testid="User-Name"] ~ div span, [data-testid="placementTracking"] span',
    bodyExclude: '[data-testid="tweetText"], [data-testid="card.wrapper"], div[role="link"][tabindex="0"]',
    followSlot: '[data-testid$="-follow"]',
    followMeansSuggested: true,
    modules: [
      { selector: '[aria-label="Timeline: Trending now"]', description: "Trending now panel in the right sidebar" },
      { selector: '[data-testid="sidebarColumn"] section:has(a[href^="/i/connect_people"])', description: "Who to follow suggestions in the right sidebar" },
      { selector: 'div[data-testid^="news_sidebar"]', description: "News/trends module in the right sidebar" },
      { selector: 'a[href*="src=promoted_trend_click"]', description: "Promoted trend link" },
      { selector: 'aside[aria-label="Subscribe to Premium"]', description: "Premium subscription upsell in the right sidebar" },
      { selector: 'a[href="/i/grok"]', description: "Grok link in the left navigation" }
    ],
    excludedPaths: [/^\/messages/, /^\/i\/chat/],
    feedPaths: [/^\/home/, /^\/search/, /^\/[^/]+\/status\//, /^\/explore/]
  },
  instagram: {
    id: "instagram",
    hosts: ["www.instagram.com"],
    item: "article",
    collapseHidden: true,
    adSelectors: [],
    labelSlots: 'article header span, article header a[role="link"] + div span, article span[dir="auto"] span:not([dir])',
    bodyExclude:
      'article h1, article ul li, article div[role="button"] span[dir="auto"], article span[dir="auto"] span[dir="auto"], article div[data-interactable] div[data-interactable], article span[dir="auto"] > span',
    followSlot: 'article header button, article div[data-interactable] [role="button"], article div[data-interactable] button',
    followMeansSuggested: true,
    modules: [
      { selector: 'div:has(> div > a[href="/explore/people/"])', description: "Suggested accounts module" },
      { selector: 'a[href="/reels/"], a[href^="/reels/?"]', description: "Reels link in the navigation" },
      { selector: 'a[href="/explore/"], a[href^="/explore/?"]', description: "Explore link in the navigation" },
      { selector: 'div[role="presentation"]:has(> div > ul > li > div[role="button"][aria-label])', description: "Stories tray", blur: true },
      { selector: "div:has(> div > div > button)", description: "Suggested account rows", paths: /^\/explore\/people/ },
      { selector: 'div:has(> div > div > a[href^="/p/"])', description: "Explore tiles", paths: /^\/explore\/?$/ }
    ],
    excludedPaths: [/^\/direct/],
    feedPaths: [/^\/$/, /^\/explore/]
  },
  linkedin: {
    id: "linkedin",
    hosts: ["www.linkedin.com"],
    item: 'div.feed-shared-update-v2, div[data-testid="mainFeed"] div[role="listitem"]',
    adSelectors: [
      '[componentkey*="urn:li:sponsoredContentV2"]',
      "[data-sponsored-tracking-url]",
      '[data-is-sponsored="true"]',
      "article[data-is-sponsored]"
    ],
    labelSlots:
      ".update-components-actor__sub-description, .update-components-actor__description, .update-components-header__text-view, .update-components-header, h2 + div p[componentkey], h2 + p[componentkey]",
    bodyExclude:
      ".update-components-text, .feed-shared-inline-show-more-text, .update-components-article, .feed-shared-update-v2__description, span[data-testid=\"expandable-text-box\"]",
    followSlot: ".update-components-actor button, button.follow",
    followMeansSuggested: true,
    modules: [
      { selector: 'aside[aria-label="LinkedIn News"]', description: "LinkedIn News panel" },
      { selector: "#feed-news-module", description: "LinkedIn News module in the feed sidebar" },
      { selector: ".feed-shared-news-module", description: "LinkedIn News module" },
      { selector: ".feed-follows-module", description: "Follow suggestions module" },
      { selector: "section:has(.games-entrypoints-module__subheader)", description: "Games entry-point module" },
      { selector: 'div:has(> iframe[componentkey$="_feed_ad"])', description: "Right-rail ad placement: the container wrapping the cross-origin ad iframe" },
      { selector: '[componentkey$="_feed_ad"]:not(iframe)', description: "Right-rail ad placement rendered as a DOM card instead of an iframe" }
    ],
    excludedPaths: [/^\/messaging/],
    feedPaths: [/^\/feed/]
  }
};

export function siteForHost(host: string): SiteId | null {
  for (const site of Object.values(SITES)) {
    if (site.hosts.includes(host)) return site.id;
  }
  return null;
}

export interface SelectorProblem {
  site: string;
  field: "item" | "adSelectors" | "labelSlots" | "followSlot" | "modules" | "bodyExclude";
  index: number;
  selector: string;
  error: string;
}

export function validateSelectors(sites: Partial<Record<string, SiteConfig>> = SITES): SelectorProblem[] {
  const problems: SelectorProblem[] = [];
  const check = (site: string, field: SelectorProblem["field"], index: number, selector: string): void => {
    if (selector === "") return;
    try {
      document.querySelector(selector);
    } catch (e) {
      problems.push({ site, field, index, selector, error: e instanceof Error ? e.message : String(e) });
    }
  };
  for (const [site, cfg] of Object.entries(sites)) {
    if (!cfg) continue;
    check(site, "item", 0, cfg.item);
    cfg.adSelectors.forEach((s, i) => check(site, "adSelectors", i, s));
    check(site, "labelSlots", 0, cfg.labelSlots);
    check(site, "followSlot", 0, cfg.followSlot);
    cfg.modules.forEach((m, i) => check(site, "modules", i, m.selector));
    check(site, "bodyExclude", 0, cfg.bodyExclude);
  }
  return problems;
}
