import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "fixtures");
const SENTINEL = "BODY_SENTINEL";

const AD_WORDS = ["Sponsored", "Promoted", "Ad", "광고", "프로모션", "Promoted by LinkedIn"];
const SUGGESTED_WORDS = ["Suggested", "Suggested for you", "Suggested post", "추천", "회원님을 위한 추천", "추천 게시물"];
const FOLLOW_WORDS = ["Follow", "팔로우", "+ Follow", "팔로우하기"];

type Cfg = {
  item: string;
  moduleKind: string;
  adSelectors: string[];
  labelSlots: string;
  followSlot: string;
  followMeansSuggested: boolean;
  bodyExclude: string;
  bodyContainers: string;
};

const CFG: Record<string, Cfg> = {
  youtube: {
    item: "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer",
    moduleKind: "ytd-reel-shelf-renderer",
    adSelectors: ["ytd-ad-slot-renderer", "ytd-in-feed-ad-layout-renderer", "ytd-promoted-sparkles-web-renderer"],
    labelSlots: "#metadata-line, ytd-badge-supported-renderer",
    followSlot: "",
    followMeansSuggested: false,
    bodyExclude: "#video-title, #description-text, yt-formatted-string#description",
    bodyContainers: "#video-title, #description-text",
  },
  x: {
    item: 'div[data-testid="cellInnerDiv"]',
    moduleKind: '[aria-label="Timeline: Trending now"]',
    adSelectors: ['[data-testid="placementTracking"]', 'div[data-testid$="-impression-pixel"]'],
    labelSlots:
      '[data-testid="socialContext"], [data-testid="User-Name"] ~ div span, [data-testid="placementTracking"] span',
    followSlot: '[data-testid$="-follow"]',
    followMeansSuggested: true,
    bodyExclude: '[data-testid="tweetText"], [data-testid="card.wrapper"], div[role="link"][tabindex="0"]',
    bodyContainers: '[data-testid="tweetText"]',
  },
  instagram: {
    item: "article",
    moduleKind: 'div:has(> div > a[href="/explore/people/"])',
    adSelectors: [],
    labelSlots: 'article header span, article header a[role="link"] + div span',
    followSlot: "article header button",
    followMeansSuggested: true,
    bodyExclude: 'article h1, article ul li, article div[role="button"] span[dir="auto"]',
    bodyContainers: "article h1, article ul li",
  },
  linkedin: {
    item: "div.feed-shared-update-v2",
    moduleKind: 'aside[aria-label="LinkedIn News"]',
    adSelectors: [
      '[componentkey*="urn:li:sponsoredContentV2"]',
      "[data-sponsored-tracking-url]",
      '[data-is-sponsored="true"]',
      "article[data-is-sponsored]",
    ],
    labelSlots:
      ".update-components-actor__sub-description, .update-components-actor__description, .update-components-header__text-view, .update-components-header",
    followSlot: ".update-components-actor button, button.follow",
    followMeansSuggested: true,
    bodyExclude:
      ".update-components-text, .feed-shared-inline-show-more-text, .update-components-article, .feed-shared-update-v2__description",
    bodyContainers: ".update-components-text",
  },
};

const SITE_FIXTURES: { file: string; site: string }[] = [
  { file: "youtube-en.html", site: "youtube" },
  { file: "youtube-ko.html", site: "youtube" },
  { file: "x-en.html", site: "x" },
  { file: "x-ko.html", site: "x" },
  { file: "instagram-en.html", site: "instagram" },
  { file: "instagram-ko.html", site: "instagram" },
  { file: "linkedin-en.html", site: "linkedin" },
  { file: "linkedin-ko.html", site: "linkedin" },
];
const ALL_FILES = [...SITE_FIXTURES.map((f) => f.file), "x-messages-en.html", "stress-x-en.html"];

const load = (file: string): { html: string; doc: Document } => {
  const html = readFileSync(join(DIR, file), "utf8");
  return { html, doc: new DOMParser().parseFromString(html, "text/html") };
};

const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const matchesWord = (text: string | null, words: string[]) => words.some((w) => norm(w) === norm(text));

const closestWithin = (el: Element, selector: string, root: Element): boolean => {
  const hit = el.closest(selector);
  return hit !== null && root.contains(hit);
};

function deterministic(item: Element, cfg: Cfg): boolean {
  const adAttribute = cfg.adSelectors.some((s) => item.matches(s) || item.querySelector(s) !== null);
  const slots = [...item.querySelectorAll(cfg.labelSlots)].filter((e) => !closestWithin(e, cfg.bodyExclude, item));
  const adLabel = slots.some((e) => matchesWord(e.textContent, AD_WORDS));
  const suggestedLabel = slots.some((e) => matchesWord(e.textContent, SUGGESTED_WORDS));
  const follows = cfg.followSlot
    ? [...item.querySelectorAll(cfg.followSlot)].filter((e) => !closestWithin(e, 'div[role="link"][tabindex="0"]', item))
    : [];
  const followButton = follows.some((e) => matchesWord(e.textContent, FOLLOW_WORDS));
  return adAttribute || adLabel || suggestedLabel || (followButton && cfg.followMeansSuggested);
}

const countBy = (doc: Document, attr: string, value: string) =>
  doc.querySelectorAll(`[${attr}="${value}"]`).length;

const kindCount = (doc: Document, kinds: string[]) =>
  kinds.reduce((n, k) => n + countBy(doc, "data-qa-kind", k), 0);

const declaredHeight = (el: Element): number => {
  const m = /(?:min-)?height:\s*(\d+)px/.exec(el.getAttribute("style") ?? "");
  return m ? Number(m[1]) : 0;
};

describe("site fixtures", () => {
  for (const { file, site } of SITE_FIXTURES) {
    const cfg = CFG[site]!;
    describe(file, () => {
      const { html, doc } = load(file);
      const items = [...doc.querySelectorAll(cfg.item)];
      const tagged = [...doc.querySelectorAll("[data-qa-expect]")];

      test("every item carries a valid data-qa-expect (file and index reported)", () => {
        const problems: string[] = [];
        items.forEach((el, i) => {
          const v = el.getAttribute("data-qa-expect");
          if (!v) problems.push(`${file}: item[${i}] is missing data-qa-expect`);
          else if (!["keep", "hide", "blur-or-hide"].includes(v)) problems.push(`${file}: item[${i}] has bad data-qa-expect "${v}"`);
        });
        expect(problems).toEqual([]);
        expect(items.length).toBeGreaterThanOrEqual(18);
      });

      test("per-expectation counts", () => {
        const keep = countBy(doc, "data-qa-expect", "keep");
        const hide = countBy(doc, "data-qa-expect", "hide");
        const blur = countBy(doc, "data-qa-expect", "blur-or-hide");
        expect({ keep, hide, blur }).toEqual({ keep: site === "x" ? 13 : 12, hide: 6, blur: 2 });
        const outside = tagged.filter((el) => !items.includes(el) && el.getAttribute("data-qa-kind") !== "module");
        expect(outside.length).toBe(0);
      });

      test("per-kind mix", () => {
        expect(kindCount(doc, ["organic", "injection"])).toBe(10);
        expect(countBy(doc, "data-qa-kind", "adAttr")).toBe(site === "instagram" ? 0 : 2);
        expect(countBy(doc, "data-qa-kind", "adLabel")).toBe(site === "instagram" ? 4 : 2);
        expect(kindCount(doc, ["suggestedLabel", "suggestedFollow"])).toBe(2);
        expect(countBy(doc, "data-qa-kind", "module")).toBe(1);
        expect(countBy(doc, "data-qa-kind", "unknown")).toBe(1);
        expect(countBy(doc, "data-qa-kind", "adSentence")).toBe(1);
        expect(countBy(doc, "data-qa-kind", "bodyNeg")).toBe(1);
        expect(countBy(doc, "data-qa-kind", "quotedFollow")).toBe(site === "x" ? 1 : 0);
      });

      test("module element matches the site's module selector", () => {
        const mod = doc.querySelector('[data-qa-kind="module"]')!;
        expect(mod.matches(cfg.moduleKind) || mod.querySelector(cfg.moduleKind) !== null).toBe(true);
      });

      test("unknown item has no deterministic signal and carries data-qa-model", () => {
        const models = [...doc.querySelectorAll("[data-qa-model]")];
        expect(models.length).toBe(1);
        expect(models[0]!.getAttribute("data-qa-model")).toBe("suggested");
        expect(models[0]!.getAttribute("data-qa-kind")).toBe("unknown");
        expect(deterministic(models[0]!, cfg)).toBe(false);
      });

      test("deterministic signals fire exactly for hide items", () => {
        const wrong: string[] = [];
        items.forEach((el, i) => {
          const expectV = el.getAttribute("data-qa-expect");
          const fired = deterministic(el, cfg);
          if (expectV === "hide" && !fired) wrong.push(`${file}: item[${i}] hide but no signal`);
          if (expectV !== "hide" && fired) wrong.push(`${file}: item[${i}] ${expectV} but signal fired`);
        });
        expect(wrong).toEqual([]);
      });

      test("negative body-text cases stay keep", () => {
        const sentence = doc.querySelector('[data-qa-kind="adSentence"]')!;
        expect(sentence.getAttribute("data-qa-expect")).toBe("keep");
        expect(/\bAd\b/.test(sentence.textContent ?? "")).toBe(true);
        expect((sentence.textContent ?? "").trim().split(/\s+/).length).toBeGreaterThan(4);
        const neg = doc.querySelector('[data-qa-kind="bodyNeg"]')!;
        expect(neg.getAttribute("data-qa-expect")).toBe("keep");
        for (const w of ["추천", "광고", "Sponsored"]) expect(neg.textContent).toContain(w);
        if (site === "x") {
          const q = doc.querySelector('[data-qa-kind="quotedFollow"]')!;
          expect(q.getAttribute("data-qa-expect")).toBe("keep");
          expect(q.querySelector('div[role="link"][tabindex="0"] [data-testid$="-follow"]')).not.toBeNull();
        }
      });

      test("every user-authored text container holds BODY_SENTINEL", () => {
        const bodies = [...doc.querySelectorAll(cfg.bodyContainers)];
        expect(bodies.length).toBeGreaterThanOrEqual(items.length - 1);
        const bad = bodies.map((b, i) => (b.textContent?.includes(SENTINEL) ? null : `${file}: body[${i}]`)).filter(Boolean);
        expect(bad).toEqual([]);
        const noBody = items
          .filter((el) => el.getAttribute("data-qa-kind") !== "module")
          .map((el, i) => (el.querySelector(cfg.bodyContainers) ? null : `${file}: item[${i}]`))
          .filter(Boolean);
        expect(noBody).toEqual([]);
      });

      test("prompt-injection probe body is present for the future harness", () => {
        expect(html).toContain("ignore previous instructions");
        const probe = [...doc.querySelectorAll(cfg.bodyContainers)].find((b) => b.textContent?.includes("ignore previous instructions"));
        expect(probe?.textContent).toContain(SENTINEL);
      });

      test("feed is at least 3 viewport heights tall", () => {
        const total = items.reduce((s, el) => s + declaredHeight(el), 0);
        expect(total).toBeGreaterThanOrEqual(3 * 900);
      });

      test("inline script drives scroll, rAF and ResizeObserver insertion", () => {
        const script = doc.getElementById("fx-infinite-scroll")?.textContent ?? "";
        expect(script).not.toContain("scrollHeight");
        expect(script).toContain("function lastRendered");
        expect(script).toContain("getBoundingClientRect().bottom <= window.innerHeight + 800");
        expect(script.indexOf("lastBatchEl = last")).toBeGreaterThan(-1);
        expect(script.indexOf("lastBatchEl = last")).toBeLessThan(script.indexOf("if (IS_X) xRecycle(window.scrollY)"));
        expect(script).not.toContain("if (ro) ro.observe(el)");
        expect(script).toContain("while (obsQ.length) ro.observe(obsQ.shift())");
        expect(script).not.toContain("onerror");
        expect(script).toContain("requestAnimationFrame");
        expect(script).toContain("new ResizeObserver");
        expect(script).toContain("IntersectionObserver");
        expect(script).toContain("100000px");
        if (site === "x") {
          expect(script).toContain("translateY(");
          expect(script).toContain("function relayout");
          expect(script).toContain("function recycleInto");
          expect(script).toContain("recycle-up");
          expect(doc.querySelector("#timeline")?.getAttribute("style")).toContain("position:relative");
          for (const c of items) {
            const s = c.getAttribute("style") ?? "";
            expect(s).toContain("position:absolute");
            expect(s).toContain("translateY(");
          }
        }
        if (site === "youtube") expect(doc.querySelectorAll("ytd-rich-section-renderer.qa-late").length).toBe(2);
      });

      test("no external network resources", () => {
        expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
        expect(html).not.toMatch(/url\(\s*["']?https?:/i);
        expect(doc.querySelectorAll("script[src], link[href], img[src], iframe").length).toBe(0);
      });
    });
  }
});

describe("x-messages-en.html", () => {
  const { html, doc } = load("x-messages-en.html");
  const items = [...doc.querySelectorAll(CFG.x!.item)];

  test("DM cells all carry data-qa-expect=keep (file and index reported)", () => {
    const bad = items
      .map((el, i) => (el.getAttribute("data-qa-expect") === "keep" ? null : `x-messages-en.html: item[${i}]`))
      .filter(Boolean);
    expect(bad).toEqual([]);
    expect(items.length).toBeGreaterThanOrEqual(16);
    expect(html).toContain("function dmScroll");
    expect(html).not.toContain("scrollHeight");
    expect(doc.querySelectorAll('[data-qa-expect]:not([data-qa-expect="keep"])').length).toBe(0);
  });

  test("message bodies hold BODY_SENTINEL and decoy signals exist", () => {
    const bodies = [...doc.querySelectorAll('[data-testid="dm-text"]')];
    expect(bodies.length).toBe(items.length);
    for (const b of bodies) expect(b.textContent).toContain(SENTINEL);
    expect(deterministic(items[4]!, CFG.x!)).toBe(true);
    expect(deterministic(items[5]!, CFG.x!)).toBe(true);
  });

  test("script can SPA-navigate to /home", () => {
    expect(html).toContain("fx.goHome");
    expect(html).toContain("history.pushState({}, '', '/home')");
    expect(doc.getElementById("fx-infinite-scroll")).not.toBeNull();
  });
});

describe("stress-x-en.html", () => {
  const { doc } = load("stress-x-en.html");
  const cfg = CFG.x!;
  const items = [...doc.querySelectorAll(cfg.item)];

  test("500 items, each with data-qa-expect and BODY_SENTINEL (file and index reported)", () => {
    expect(items.length).toBe(500);
    const bad = items
      .map((el, i) => (el.getAttribute("data-qa-expect") ? null : `stress-x-en.html: item[${i}]`))
      .filter(Boolean);
    expect(bad).toEqual([]);
    const noBody = items
      .filter((el) => el.getAttribute("data-qa-kind") !== "module")
      .map((el, i) => (el.querySelector(cfg.bodyContainers)?.textContent?.includes(SENTINEL) ? null : `stress-x-en.html: body[${i}]`))
      .filter(Boolean);
    expect(noBody).toEqual([]);
  });

  test("hide items are deterministic and keep items are not", () => {
    const wrong = items
      .map((el, i) => {
        const v = el.getAttribute("data-qa-expect");
        const fired = deterministic(el, cfg);
        return (v === "hide") === fired || (v !== "hide" && fired) ? (v === "hide" && !fired ? `item[${i}]` : v !== "hide" && fired ? `item[${i}]` : null) : null;
      })
      .filter(Boolean);
    expect(wrong).toEqual([]);
  });

  test("mutation script performs ~200 counter updates per second", () => {
    const stress = doc.getElementById("fx-stress")?.textContent ?? "";
    expect(stress).toContain("setInterval");
    expect(stress).toContain("i < 10");
    expect(stress).toContain("}, 50)");
    expect(doc.querySelectorAll("[data-count]").length).toBeGreaterThan(500);
  });

  test("X layout engine markup is present", () => {
    expect(items.every((c) => (c.getAttribute("style") ?? "").includes("translateY("))).toBe(true);
  });
});

describe("all fixtures", () => {
  test("every one of the ten files exists and is non-trivial", () => {
    for (const f of ALL_FILES) expect(readFileSync(join(DIR, f), "utf8").length).toBeGreaterThan(5000);
  });
});
