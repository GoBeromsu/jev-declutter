import type { SiteId } from "./types";

// Per-site knowledge. Selectors are 2026 evidence from uBlock uAssets/EasyList and maintained
// extensions (irbis-sh/filter-lists no-doomscroll, news-feed-eradicator, linkedin-feed-cleaner).
// The sites change markup without notice: verify with the fixtures in tests/fixtures.
// LinkedIn additionally ships a React/SDUI feed (role="listitem" cards, hashed class names, no
// .update-components-* slots) to some accounts; its selectors sit alongside the legacy ones and
// are structure-only evidence from the 2026-10-29 live probe recorded in
// .omo/evidence/task-18-aside-feed-declutter.txt (fixtures: tests/fixtures/linkedin-react-*.html).
// The LinkedIn right-rail ad selectors come from a second 2026-10-29 structure probe recorded in
// .omo/evidence/task-25-aside-feed-declutter.txt.

export interface SiteModule {
  selector: string;
  description: string;
}

export interface SiteConfig {
  id: SiteId;
  hosts: string[];
  /** One feed item (a post, a video card). */
  item: string;
  /** Structural ad markers, matched on the item or inside it. */
  adSelectors: string[];
  /** UI-chrome label slots; the only places label words are read from. */
  labelSlots: string;
  /** Follow-button slot; empty string = none. */
  followSlot: string;
  followMeansSuggested: boolean;
  /** Recommendation modules removed as a whole. */
  modules: SiteModule[];
  excludedPaths: RegExp[];
  feedPaths: RegExp[];
  navEvent?: string;
  /** Containers of user-authored content: no labelSlots/followSlot element inside them is ever read. */
  bodyExclude: string;
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
    adSelectors: [],
    labelSlots: 'article header span, article header a[role="link"] + div span',
    bodyExclude: 'article h1, article ul li, article div[role="button"] span[dir="auto"]',
    followSlot: "article header button",
    followMeansSuggested: true,
    modules: [
      { selector: 'div:has(> div > a[href="/explore/people/"])', description: "Suggested accounts module" },
      { selector: 'a[href="/reels/"]', description: "Reels link in the navigation" },
      { selector: 'a[href="/explore/"]', description: "Explore link in the navigation" }
    ],
    excludedPaths: [/^\/direct/],
    feedPaths: [/^\/$/, /^\/explore/]
  },
  linkedin: {
    id: "linkedin",
    hosts: ["www.linkedin.com"],
    item: 'div.feed-shared-update-v2, div[data-testid="mainFeed"] div[role="listitem"]',
    // React markup adds no ad selector: the live probe found 0 elements whose attribute name or
    // value contains "sponsor"/"promot" anywhere in the feed, so React ads are label-only.
    adSelectors: [
      '[componentkey*="urn:li:sponsoredContentV2"]',
      "[data-sponsored-tracking-url]",
      '[data-is-sponsored="true"]',
      "article[data-is-sponsored]"
    ],
    // The last two selectors cover LinkedIn's 2026 React feed (see the header note). `h2 + div
    // p[componentkey]` is the actor sub-description inside the block following the post's hidden
    // a11y heading; it holds "Promoted" / "프로모션". `h2 + p[componentkey]` is the update-level
    // chrome paragraph (the position the legacy `.update-components-header__text-view` header
    // occupied).
    // Both qualifiers are load-bearing, not decoration:
    //  - `[componentkey]`: the keyless sibling paragraph is the author headline (live max 197
    //    chars of author bio, which must never reach a request), while all live markers sit in
    //    keyed paragraphs of at most 43 chars.
    //  - `+` and not `~`: the post commentary is a LATER keyed `p` sibling of the same heading, so
    //    the general-sibling form would admit the body wrapper as a label slot (live 9 of 9 of its
    //    extra matches wrapped the body span) and leave bodyExclude's expandable-text-box entry as
    //    the only thing keeping post text out of chrome_text. Adjacent-sibling keeps every hide
    //    verdict and opens one slot instead of nineteen. Pinned by the testid-removal test in
    //    tests/signals.test.ts.
    // The live keyed actor paragraph also WRAPS the member's `/in/` profile anchor: 12 of 30 and
    // 10 of 31 live slots in two measured sessions, anchor text up to 37 chars, reaching
    // chrome_text verbatim every time. A `:not(:has(a))` qualifier would discard the whole slot
    // and lose any marker sharing it, so the name is dropped at the TEXT READ instead: `slotText`
    // in src/signals.ts skips nested `a[href]` subtrees for every site.
    labelSlots:
      ".update-components-actor__sub-description, .update-components-actor__description, .update-components-header__text-view, .update-components-header, h2 + div p[componentkey], h2 + p[componentkey]",
    bodyExclude:
      ".update-components-text, .feed-shared-inline-show-more-text, .update-components-article, .feed-shared-update-v2__description, span[data-testid=\"expandable-text-box\"]",
    // No React-markup follow slot: on the live React feed 4 of 26 ORGANIC items (reposts by a
    // connection, company pages) carry a Follow button, so with followMeansSuggested a React
    // follow slot would hide organic posts. React suggested items are detected by label only.
    followSlot: ".update-components-actor button, button.follow",
    followMeansSuggested: true,
    // React markup adds no recommendation module: the todo 18 live probe found no recommendation
    // rail at all (the only asides were an empty sidebar and the ad column).
    // The last two selectors cover that ad column - LinkedIn's right-rail ad placement, F3
    // finding L1. A 2026-10-29 read-only structure probe of the live rail found the placement
    // rendered as a 300x250 cross-origin iframe carrying the SDUI slot key
    // `componentkey="MainFeedDesktopNav_feed_ad"`, inside a wrapper div whose only attribute is a
    // hashed-class list (`ajr*` build output), under a rail `aside` with no stable hook either.
    // The slot key is the one non-hashed handle on the placement: over 12 live loads it was the
    // single componentkey value containing "ad", `[componentkey$="_feed_ad"]` matched exactly one
    // element per load, and it never appeared on a feed item, the profile card, the news rail
    // widget or the games rail widget (`feedRightNavGamesComponentRef`). `$=` and not `*=`, so a
    // future `feed_adjacent`-style slot name cannot match.
    //  - the `:has(> iframe ...)` entry hides the CONTAINER rather than the frame alone, and the
    //    direct-child combinator keeps it on the tight wrapper instead of the rail column.
    //  - the `:not(iframe)` entry covers the DOM "Promoted" card variant F3 recorded in the same
    //    slot. That variant did not reproduce in 12 live loads on 2026-10-29, so it is covered
    //    structurally - same slot key, any tag - and never by a guessed label or class.
    // The frame's contents are cross-origin and are never read: only the container is treated.
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
  /** Index inside list fields; 0 for single-selector fields. */
  index: number;
  selector: string;
  error: string;
}

/** Checks every selector of every site parses; requires a DOM (document). */
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
