import { describe, expect, test } from "bun:test";
import { AD_WORDS, FOLLOW_WORDS, SUGGESTED_WORDS, matchesWord } from "../src/markers";
import { SITES, siteForHost, validateSelectors, type SiteConfig } from "../src/sites";

const IDS = ["youtube", "x", "instagram", "linkedin"] as const;

describe("matchesWord", () => {
  test("trims, collapses whitespace and ignores case", () => {
    expect(matchesWord("  광고 ", AD_WORDS)).toBe(true);
    expect(matchesWord("sponsored", AD_WORDS)).toBe(true);
    expect(matchesWord("Promoted   by\n LinkedIn", AD_WORDS)).toBe(true);
    expect(matchesWord("  회원님을  위한 추천 ", SUGGESTED_WORDS)).toBe(true);
    expect(matchesWord("+ follow", FOLLOW_WORDS)).toBe(true);
  });

  test("exact token only, never a substring", () => {
    expect(matchesWord("Add", AD_WORDS)).toBe(false);
    expect(matchesWord("Ad blocker tips", AD_WORDS)).toBe(false);
    expect(matchesWord("광고주", AD_WORDS)).toBe(false);
    expect(matchesWord("Sponsored by a friend", AD_WORDS)).toBe(false);
    expect(matchesWord("Following", FOLLOW_WORDS)).toBe(false);
  });

  test("empty and whitespace-only text never match", () => {
    expect(matchesWord("", AD_WORDS)).toBe(false);
    expect(matchesWord("   \n\t ", AD_WORDS)).toBe(false);
    expect(matchesWord("Ad", [])).toBe(false);
  });

  test("word lists carry both English and Korean", () => {
    for (const list of [AD_WORDS, SUGGESTED_WORDS, FOLLOW_WORDS]) {
      expect(list.some((w) => /[가-힣]/.test(w))).toBe(true);
      expect(list.some((w) => /^[A-Za-z+ ]+$/.test(w))).toBe(true);
    }
  });
});

describe("siteForHost", () => {
  test("maps hosts to site ids", () => {
    expect(siteForHost("www.linkedin.com")).toBe("linkedin");
    expect(siteForHost("www.youtube.com")).toBe("youtube");
    expect(siteForHost("x.com")).toBe("x");
    expect(siteForHost("twitter.com")).toBe("x");
    expect(siteForHost("www.instagram.com")).toBe("instagram");
    expect(siteForHost("example.com")).toBeNull();
  });
});

describe("SITES table", () => {
  test("covers the four sites with matching ids", () => {
    expect(Object.keys(SITES).sort()).toEqual([...IDS].sort());
    for (const id of IDS) expect(SITES[id].id).toBe(id);
  });

  test("every selector parses via document.querySelector", () => {
    expect(validateSelectors(SITES)).toEqual([]);
    for (const id of IDS) {
      const c = SITES[id];
      const all = [c.item, c.labelSlots, c.bodyExclude, ...c.adSelectors, ...c.modules.map((m) => m.selector)];
      if (c.followSlot) all.push(c.followSlot);
      for (const s of all) expect(() => document.querySelector(s)).not.toThrow();
    }
  });

  test("every site has bodyExclude and label slots; module descriptions are non-empty", () => {
    for (const id of IDS) {
      expect(SITES[id].bodyExclude.trim().length).toBeGreaterThan(0);
      expect(SITES[id].labelSlots.trim().length).toBeGreaterThan(0);
      expect(SITES[id].modules.length).toBeGreaterThan(0);
      for (const m of SITES[id].modules) expect(m.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("X labelSlots never include the tweet-body selector removed by review", () => {
    expect(SITES.x.labelSlots).not.toContain('div[dir="ltr"] > span');
    expect(SITES.x.bodyExclude).toContain('[data-testid="tweetText"]');
  });

  test("selector table matches the plan values", () => {
    expect(SITES.youtube.hosts).toEqual(["www.youtube.com"]);
    expect(SITES.youtube.followSlot).toBe("");
    expect(SITES.youtube.followMeansSuggested).toBe(false);
    expect(SITES.youtube.navEvent).toBe("yt-navigate-finish");
    expect(SITES.x.hosts).toEqual(["x.com", "twitter.com"]);
    expect(SITES.x.item).toBe('div[data-testid="cellInnerDiv"]');
    expect(SITES.x.followSlot).toBe('[data-testid$="-follow"]');
    expect(SITES.instagram.adSelectors).toEqual([]);
    expect(SITES.instagram.item).toBe("article");
    expect(SITES.linkedin.adSelectors).toContain('[componentkey*="urn:li:sponsoredContentV2"]');
    expect(SITES.linkedin.followMeansSuggested).toBe(true);
  });

  test("excludedPaths cover DM and messaging routes", () => {
    const hit = (id: (typeof IDS)[number], path: string) => SITES[id].excludedPaths.some((r) => r.test(path));
    expect(hit("linkedin", "/messaging/thread/1")).toBe(true);
    expect(hit("instagram", "/direct/inbox/")).toBe(true);
    expect(hit("x", "/messages")).toBe(true);
    expect(hit("x", "/i/chat/abc")).toBe(true);
    expect(hit("x", "/home")).toBe(false);
    expect(SITES.youtube.excludedPaths).toEqual([]);
  });

  test("feedPaths match the feed routes", () => {
    const feed = (id: (typeof IDS)[number], path: string) => SITES[id].feedPaths.some((r) => r.test(path));
    expect(feed("youtube", "/")).toBe(true);
    expect(feed("youtube", "/watch")).toBe(true);
    expect(feed("x", "/home")).toBe(true);
    expect(feed("x", "/someone/status/123")).toBe(true);
    expect(feed("instagram", "/")).toBe(true);
    expect(feed("linkedin", "/feed/")).toBe(true);
    expect(feed("linkedin", "/messaging/")).toBe(false);
  });
});

describe("validateSelectors", () => {
  test("reports site and index for an intentionally invalid selector", () => {
    const bad: SiteConfig = {
      ...SITES.x,
      adSelectors: ['[data-testid="placementTracking"]', "div[[broken"]
    };
    const problems = validateSelectors({ x: bad });
    expect(problems.length).toBe(1);
    expect(problems[0]!.site).toBe("x");
    expect(problems[0]!.field).toBe("adSelectors");
    expect(problems[0]!.index).toBe(1);
    expect(problems[0]!.selector).toBe("div[[broken");
  });

  test("reports an invalid module selector with its index", () => {
    const bad: SiteConfig = {
      ...SITES.linkedin,
      modules: [...SITES.linkedin.modules, { selector: ":::nope", description: "bad" }]
    };
    const problems = validateSelectors({ linkedin: bad });
    expect(problems.map((p) => [p.site, p.field, p.index])).toEqual([["linkedin", "modules", SITES.linkedin.modules.length]]);
  });
});
