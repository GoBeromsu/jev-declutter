import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("LinkedIn right-rail ad placement", () => {
  const cfg = SITES.linkedin;
  const modules = cfg.modules.map((m) => m.selector).join(",");
  const load = (file: string): Document =>
    new DOMParser().parseFromString(readFileSync(join(import.meta.dir, "fixtures", file), "utf8"), "text/html");

  for (const file of ["linkedin-react-en.html", "linkedin-react-ko.html"]) {
    describe(file, () => {
      const doc = load(file);

      test("both rail ad containers match a module selector, and nothing else is added", () => {
        const matched = [...doc.querySelectorAll(modules)];
        expect(matched.map((el) => el.getAttribute("data-qa-id"))).toEqual(["init-9", "init-20", "init-21"]);
        for (const el of matched.slice(1)) expect(el.getAttribute("data-qa-kind")).toBe("module");
      });

      test("the iframe variant is treated through its container, never through the frame", () => {
        const frame = doc.querySelector('iframe[componentkey$="_feed_ad"]')!;
        expect(frame.getAttribute("src")).toBe("about:blank");
        expect(frame.matches(modules)).toBe(false);
        expect(frame.parentElement!.matches(modules)).toBe(true);
        expect(frame.parentElement!.getAttribute("data-qa-id")).toBe("init-20");
      });

      test("the DOM card variant matches on the slot key alone, with no tag or label guess", () => {
        const card = doc.querySelector('[data-qa-id="init-21"]')!;
        expect(card.tagName.toLowerCase()).toBe("div");
        expect(card.querySelector("iframe")).toBeNull();
        expect(card.matches(modules)).toBe(true);
      });

      test("the non-ad rail widget stays unmatched, inside and out", () => {
        const widget = doc.querySelector('[data-qa-kind="railNegative"]')!;
        expect(widget.getAttribute("componentkey")).toBe("feedRightNavGamesComponentRef");
        expect(widget.matches(modules)).toBe(false);
        expect(widget.querySelectorAll(modules).length).toBe(0);
        expect(widget.closest(modules)).toBeNull();
      });

      test("no feed item and nothing inside one matches a module selector", () => {
        const items = [...doc.querySelectorAll(cfg.item)];
        expect(items.length).toBeGreaterThanOrEqual(18);
        for (const el of items) {
          expect(el.matches(modules)).toBe(false);
          expect(el.querySelectorAll(modules).length).toBe(0);
        }
        expect(doc.querySelectorAll(`[data-testid="mainFeed"] [role="listitem"] [componentkey$="_feed_ad"]`).length).toBe(0);
      });
    });
  }

  test("the rail selectors are anchored on the slot key, not on a nav prefix or a label", () => {
    const added = cfg.modules.slice(-2).map((m) => m.selector);
    expect(added).toEqual(['div:has(> iframe[componentkey$="_feed_ad"])', '[componentkey$="_feed_ad"]:not(iframe)']);
    const host = document.createElement("div");
    host.innerHTML =
      '<div id="other-nav"><span componentkey="MobileFeedNav_feed_ad"></span></div>' +
      '<div id="adjacent"><span componentkey="MainFeedDesktopNav_feed_adjacent"></span></div>';
    expect([...host.querySelectorAll(added.join(","))].map((el) => el.getAttribute("componentkey"))).toEqual([
      "MobileFeedNav_feed_ad"
    ]);
  });
});

describe("Instagram live feed slots (no <header>)", () => {
  const cfg = SITES.instagram;

  test("the live selectors are the probed ones and they reach the account row only", () => {
    expect(cfg.labelSlots.endsWith('article span[dir="auto"] span:not([dir])')).toBe(true);
    for (const entry of [
      'article span[dir="auto"] span[dir="auto"]',
      "article div[data-interactable] div[data-interactable]",
      'article span[dir="auto"] > span'
    ]) {
      expect(cfg.bodyExclude).toContain(entry);
    }
    expect(cfg.followSlot).toContain('article div[data-interactable] [role="button"]');
    const host = document.createElement("div");
    host.innerHTML =
      "<article>" +
        '<div data-interactable>' +
          '<span dir="auto"><div><a role="link" href="#"><span id="name">Member One</span></a></div></span>' +
          '<span dir="auto"><div><span id="label">Sponsored</span></div></span>' +
          '<span dir="auto"><span id="line">2h</span></span>' +
          '<div role="button" id="rowFollow"><span>Follow</span></div>' +
          '<div data-interactable><span dir="auto"><span id="pill">credit</span></span></div>' +
        "</div>" +
        '<div><span dir="auto"><div><span dir="auto" id="caption">post text</span></div></span></div>' +
        '<div role="button" id="outsideFollow"><span>Follow</span></div>' +
      "</article>";
    document.body.append(host);
    try {
      expect([...host.querySelectorAll(cfg.labelSlots)].map((el) => el.id)).toEqual(["name", "label", "line", "pill"]);
      expect(host.querySelector("#caption")!.matches(cfg.bodyExclude)).toBe(true);
      expect(host.querySelector("#line")!.closest(cfg.bodyExclude)).not.toBeNull();
      expect(host.querySelector("#pill")!.closest(cfg.bodyExclude)).not.toBeNull();
      expect(host.querySelector("#label")!.closest(cfg.bodyExclude)).toBeNull();
      expect([...host.querySelectorAll(cfg.followSlot)].map((el) => el.id)).toEqual(["rowFollow"]);
    } finally {
      host.remove();
    }
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
