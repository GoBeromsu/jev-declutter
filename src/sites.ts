import type { SiteId } from "./types";

export interface Seed {
  selector: string;
  description: string;
}

export interface SiteConfig {
  id: SiteId;
  hosts: string[];
  defaultGoal: string;
  /** Hand-curated, stable selectors. Sent every day even when absent from the current page. */
  seeds: Seed[];
  /** Containers worth discovering automatically when they carry an aria-label. */
  discover: string;
}

const LANDMARKS = "section[aria-label], aside[aria-label], nav[aria-label], [role=region][aria-label], [role=complementary][aria-label]";

// Selectors target the sites as observed in 2026 and break when the sites change their markup.
// Treat them as starting points to verify in DevTools, not as a stable contract.
export const SITES: Record<SiteId, SiteConfig> = {
  youtube: {
    id: "youtube",
    hosts: ["www.youtube.com"],
    defaultGoal: "Watch videos I searched for or from channels I subscribe to. No Shorts, no algorithmic recommendations, no autoplay bait.",
    discover: LANDMARKS,
    seeds: [
      { selector: "ytd-reel-shelf-renderer", description: "Shorts shelf in feeds and search results" },
      { selector: "ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])", description: "Shorts row on the home feed" },
      { selector: "ytd-browse[page-subtype=\"home\"] ytd-rich-grid-renderer", description: "Algorithmic home feed grid of recommended videos" },
      { selector: "ytd-watch-next-secondary-results-renderer", description: "Recommended videos sidebar next to the video being watched" },
      { selector: "ytd-comments#comments", description: "Comments section under the video being watched" },
      { selector: ".ytp-endscreen-content", description: "Recommended videos grid shown when a video ends" },
      { selector: ".ytp-ce-element", description: "End-screen cards overlaid on the video player" },
      { selector: "ytd-guide-entry-renderer:has(a[title=\"Shorts\"])", description: "Shorts link in the left navigation" },
      { selector: "ytd-mini-guide-entry-renderer[aria-label=\"Shorts\"]", description: "Shorts link in the collapsed left navigation" },
      { selector: "#masthead #search", description: "Search box in the top bar" }
    ]
  },
  x: {
    id: "x",
    hosts: ["x.com", "twitter.com"],
    defaultGoal: "Read posts from accounts I follow, search, and send messages. No trends, no follow suggestions, no upsells.",
    discover: LANDMARKS,
    seeds: [
      { selector: "[aria-label=\"Timeline: Trending now\"]", description: "Trending now panel in the right sidebar" },
      { selector: "aside[aria-label=\"Who to follow\"]", description: "Who to follow suggestions in the right sidebar" },
      { selector: "aside[aria-label=\"Subscribe to Premium\"]", description: "Premium subscription upsell in the right sidebar" },
      { selector: "a[data-testid=\"AppTabBar_Explore_Link\"]", description: "Explore link in the left navigation" },
      { selector: "a[href=\"/i/grok\"]", description: "Grok link in the left navigation" },
      { selector: "a[data-testid=\"AppTabBar_DirectMessage_Link\"]", description: "Messages link in the left navigation" },
      { selector: "[data-testid=\"SearchBox_Search_Input\"]", description: "Search box" }
    ]
  },
  instagram: {
    id: "instagram",
    hosts: ["www.instagram.com"],
    defaultGoal: "See posts and stories from people I follow and reply to messages. No Reels, no Explore, no suggested accounts.",
    discover: LANDMARKS,
    seeds: [
      { selector: "a[href=\"/reels/\"]", description: "Reels link in the navigation" },
      { selector: "a[href=\"/explore/\"]", description: "Explore link in the navigation" },
      { selector: "a[href=\"/direct/inbox/\"]", description: "Direct messages link in the navigation" },
      { selector: "a[href^=\"/explore/people/\"]", description: "See all suggested accounts link" }
    ]
  }
};

export function siteForHost(host: string): SiteId | null {
  for (const site of Object.values(SITES)) {
    if (site.hosts.includes(host)) return site.id;
  }
  return null;
}
