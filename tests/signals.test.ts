import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AD_WORDS, FOLLOW_WORDS, SUGGESTED_WORDS, matchesWord } from "../src/markers";
import { SITES, type SiteConfig } from "../src/sites";
import { extractSignals, toDescriptor } from "../src/signals";
import { deterministic } from "../src/rules";
import type { SiteId } from "../src/types";

const DIR = join(import.meta.dir, "fixtures");
const SENTINEL = "BODY_SENTINEL";

const FILES: { file: string; site: SiteId }[] = [
  { file: "youtube-en.html", site: "youtube" },
  { file: "youtube-ko.html", site: "youtube" },
  { file: "x-en.html", site: "x" },
  { file: "x-ko.html", site: "x" },
  { file: "instagram-en.html", site: "instagram" },
  { file: "instagram-ko.html", site: "instagram" },
  { file: "instagram-live-en.html", site: "instagram" },
  { file: "instagram-live-ko.html", site: "instagram" },
  { file: "linkedin-en.html", site: "linkedin" },
  { file: "linkedin-ko.html", site: "linkedin" },
  { file: "linkedin-react-en.html", site: "linkedin" },
  { file: "linkedin-react-ko.html", site: "linkedin" }
];

/** ko/en twins that must produce the same verdict sequence, by fixture prefix. */
const PAIRS: { site: SiteId; prefix: string }[] = [
  { site: "youtube", prefix: "youtube" },
  { site: "x", prefix: "x" },
  { site: "instagram", prefix: "instagram" },
  { site: "instagram", prefix: "instagram-live" },
  { site: "linkedin", prefix: "linkedin" },
  { site: "linkedin", prefix: "linkedin-react" }
];

/**
 * Per-FILE, not per-site: LinkedIn's React markup carries no structural ad attribute and no
 * legacy actor follow slot, so its only follow-slot hit is the body-nested negative control.
 * Instagram's live markup has no `<header>`, so its 21 hits are the account-row control of each
 * of the 19 items plus the two Follow controls (the suggested one and the in-body negative).
 */
const PINNED: Record<string, { ads: number; follows: number }> = {
  "youtube-en.html": { ads: 2, follows: 0 },
  "youtube-ko.html": { ads: 2, follows: 0 },
  "x-en.html": { ads: 2, follows: 2 },
  "x-ko.html": { ads: 2, follows: 2 },
  "instagram-en.html": { ads: 0, follows: 1 },
  "instagram-ko.html": { ads: 0, follows: 1 },
  "instagram-live-en.html": { ads: 0, follows: 21 },
  "instagram-live-ko.html": { ads: 0, follows: 21 },
  "linkedin-en.html": { ads: 2, follows: 1 },
  "linkedin-ko.html": { ads: 2, follows: 1 },
  "linkedin-react-en.html": { ads: 0, follows: 1 },
  "linkedin-react-ko.html": { ads: 0, follows: 1 }
};

/** The 12 matrix files plus the two X-only fixtures: the verdict and link-text guards cover all 14. */
const ALL_FIXTURES: { file: string; site: SiteId }[] = [
  ...FILES,
  { file: "x-messages-en.html", site: "x" },
  { file: "stress-x-en.html", site: "x" }
];

/**
 * Deterministic verdicts of record, measured before the slot-link guard landed. Any change to slot
 * reading that gained or lost a hide verdict on ANY fixture moves one of these numbers.
 */
const VERDICT_COUNTS: Record<string, { items: number; ad: number; suggested: number; none: number }> = {
  "youtube-en.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "youtube-ko.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "x-en.html": { items: 21, ad: 4, suggested: 2, none: 15 },
  "x-ko.html": { items: 21, ad: 4, suggested: 2, none: 15 },
  "instagram-en.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "instagram-ko.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "instagram-live-en.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "instagram-live-ko.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "linkedin-en.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "linkedin-ko.html": { items: 19, ad: 4, suggested: 2, none: 13 },
  "linkedin-react-en.html": { items: 19, ad: 4, suggested: 1, none: 14 },
  "linkedin-react-ko.html": { items: 19, ad: 4, suggested: 1, none: 14 },
  "x-messages-en.html": { items: 16, ad: 2, suggested: 0, none: 14 },
  "stress-x-en.html": { items: 500, ad: 100, suggested: 50, none: 350 }
};

const load = (file: string): Document =>
  new DOMParser().parseFromString(readFileSync(join(DIR, file), "utf8"), "text/html");

const allStrings = (v: unknown): string[] => {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v !== null && typeof v === "object") return Object.values(v).flatMap(allStrings);
  return [];
};

describe("signals over site fixtures", () => {
  for (const { file, site } of FILES) {
    const cfg = SITES[site];
    describe(file, () => {
      const doc = load(file);
      const items = [...doc.querySelectorAll(cfg.item)];

      test("item selector matches >= 18 elements", () => {
        expect(items.length).toBeGreaterThanOrEqual(18);
      });

      test("pinned selector match counts", () => {
        const ads = cfg.adSelectors.length ? doc.querySelectorAll(cfg.adSelectors.join(",")).length : 0;
        const follows = cfg.followSlot ? doc.querySelectorAll(cfg.followSlot).length : 0;
        expect({ ads, follows }).toEqual(PINNED[file]!);
      });

      test("hide items get a verdict; keep and unknown items get null", () => {
        const wrong: string[] = [];
        items.forEach((el, i) => {
          const expectV = el.getAttribute("data-qa-expect");
          const v = deterministic(extractSignals(el, cfg), cfg);
          if (expectV === "hide" && v === null) wrong.push(`${file}[${i}] hide but null`);
          if (expectV !== "hide" && v !== null) wrong.push(`${file}[${i}] ${expectV} but ${JSON.stringify(v)}`);
          if (v !== null && v.p !== 1) wrong.push(`${file}[${i}] p=${v.p}`);
        });
        expect(wrong).toEqual([]);
        expect(items.filter((e) => e.getAttribute("data-qa-expect") === "hide").length).toBeGreaterThan(0);
      });

      test("unknown, adSentence, bodyNeg, injection items give null and no label signal", () => {
        for (const kind of ["unknown", "adSentence", "bodyNeg", "injection"]) {
          const el = doc.querySelector(`[data-qa-kind="${kind}"]`)!;
          const sig = extractSignals(el, cfg);
          expect(deterministic(sig, cfg)).toBeNull();
          expect(sig.adLabel || sig.suggestedLabel || sig.adAttribute || sig.followButton).toBe(false);
        }
      });

      test("injection body text never reaches chromeText", () => {
        const el = doc.querySelector('[data-qa-kind="injection"]')!;
        expect(extractSignals(el, cfg).chromeText.join("|")).not.toMatch(/ignore previous/i);
      });

      test("chromeText is capped at 8 strings of <= 40 chars, none empty", () => {
        for (const el of items) {
          const { chromeText } = extractSignals(el, cfg);
          expect(chromeText.length).toBeLessThanOrEqual(8);
          for (const s of chromeText) {
            expect(s.length).toBeLessThanOrEqual(40);
            expect(s.length).toBeGreaterThan(0);
          }
        }
      });

      test("BODY_SENTINEL canary: no descriptor field contains the sentinel", () => {
        expect(doc.body.innerHTML).toContain(SENTINEL);
        const leaks: string[] = [];
        items.forEach((el, i) => {
          const d = toDescriptor(i, el, cfg, extractSignals(el, cfg));
          for (const s of allStrings(d)) if (s.includes(SENTINEL)) leaks.push(`${file}[${i}]: ${s}`);
        });
        expect(leaks).toEqual([]);
      });
    });
  }

  test("x-ko quoted tweet follow button does not count; own-header follow does", () => {
    const doc = load("x-ko.html");
    const cfg = SITES.x;
    const quoted = doc.querySelector('[data-qa-kind="quotedFollow"]')!;
    const sf = doc.querySelector('[data-qa-kind="suggestedFollow"]')!;
    expect(extractSignals(quoted, cfg).followButton).toBe(false);
    expect(extractSignals(sf, cfg).followButton).toBe(true);
    expect(deterministic(extractSignals(sf, cfg), cfg)).toEqual({ category: "suggested", p: 1 });
  });

  test("ko and en fixtures give identical verdict sequences", () => {
    for (const { site, prefix } of PAIRS) {
      const cfg = SITES[site];
      const run = (f: string) =>
        [...load(f).querySelectorAll(cfg.item)].map((el) => deterministic(extractSignals(el, cfg), cfg)?.category ?? null);
      expect(run(`${prefix}-ko.html`)).toEqual(run(`${prefix}-en.html`));
    }
  });
});

describe("chromeText keeps the text that justified the verdict", () => {
  const cfg = SITES.x;
  const slot = (text: string): string => `<div data-testid="socialContext">${text}</div>`;
  const build = (labels: string[]): Element => {
    const host = document.createElement("div");
    host.innerHTML = `<div>${labels.map(slot).join("")}</div>`;
    return host.firstElementChild!;
  };
  const ordinary = (n: number): string[] => Array.from({ length: n }, (_, i) => `label ${i + 1}`);

  test("eight ordinary slots then Ad: verdict is ad and Ad is in chromeText", () => {
    const sig = extractSignals(build([...ordinary(8), "Ad"]), cfg);
    expect(deterministic(sig, cfg)).toEqual({ category: "ad", p: 1 });
    expect(sig.chromeText).toEqual([...ordinary(7), "Ad"]);
  });

  test("eight ordinary slots then Suggested: verdict is suggested and Suggested is in chromeText", () => {
    const sig = extractSignals(build([...ordinary(8), "Suggested"]), cfg);
    expect(deterministic(sig, cfg)).toEqual({ category: "suggested", p: 1 });
    expect(sig.chromeText).toEqual([...ordinary(7), "Suggested"]);
  });

  test("more than eight marker slots: first eight markers kept, ordinary dropped", () => {
    const markers = [...AD_WORDS, ...SUGGESTED_WORDS];
    expect(markers.length).toBeGreaterThan(8);
    const sig = extractSignals(build(["label 1", "label 2", ...markers]), cfg);
    expect(sig.chromeText).toEqual(markers.slice(0, 8));
  });

  test("markers keep document order among ordinary slots", () => {
    const sig = extractSignals(build(["label 1", "Ad", "label 2", "Suggested", "label 3"]), cfg);
    expect(sig.chromeText).toEqual(["label 1", "Ad", "label 2", "Suggested", "label 3"]);
  });

  test("zero marker slots: first eight ordinary strings in document order", () => {
    const sig = extractSignals(build(ordinary(12)), cfg);
    expect(sig.chromeText).toEqual(ordinary(8));
    expect(deterministic(sig, cfg)).toBeNull();
  });
});

describe("marker word length guard", () => {
  test("no marker word exceeds 40 chars (slotText stops reading past 40, so longer words could never match)", () => {
    const longest = Math.max(...AD_WORDS.map((w) => w.length), ...SUGGESTED_WORDS.map((w) => w.length), ...FOLLOW_WORDS.map((w) => w.length));
    expect(longest).toBeLessThanOrEqual(40);
  });
});

describe("follow slot honours bodyExclude", () => {
  const make = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };
  const btn = '<button data-testid="42-follow">Follow</button>';

  test("X: Follow inside tweetText is not a signal", () => {
    const sig = extractSignals(make(`<div><div data-testid="tweetText">${btn}</div></div>`), SITES.x);
    expect(sig.followButton).toBe(false);
    expect(deterministic(sig, SITES.x)).toBeNull();
  });

  test("X: Follow inside card.wrapper is not a signal", () => {
    const sig = extractSignals(make(`<div><div data-testid="card.wrapper">${btn}</div></div>`), SITES.x);
    expect(sig.followButton).toBe(false);
  });

  test("X: Follow inside a quoted tweet is not a signal", () => {
    const sig = extractSignals(make(`<div><div role="link" tabindex="0">${btn}</div></div>`), SITES.x);
    expect(sig.followButton).toBe(false);
  });

  test("X: Follow in the item's own action bar still counts as suggested", () => {
    const sig = extractSignals(make(`<div><article><div class="acts">${btn}</div></article></div>`), SITES.x);
    expect(sig.followButton).toBe(true);
    expect(deterministic(sig, SITES.x)).toEqual({ category: "suggested", p: 1 });
  });

  test("LinkedIn: Follow inside a body container is not a signal", () => {
    const html = '<div><div class="update-components-text"><button class="follow">Follow</button></div></div>';
    const sig = extractSignals(make(html), SITES.linkedin);
    expect(sig.followButton).toBe(false);
    expect(deterministic(sig, SITES.linkedin)).toBeNull();
  });

  test("LinkedIn: Follow in the actor block still counts", () => {
    const html = '<div><div class="update-components-actor"><button>Follow</button></div></div>';
    expect(extractSignals(make(html), SITES.linkedin).followButton).toBe(true);
  });
});

describe("body-leak canary control", () => {
  /**
   * X's sentinel-bearing eligible slot sits inside the quoted tweet, which is BOTH a bodyExclude
   * container and a `[role="link"]` wrapper, so two independent guards now stop it and bypassing
   * one alone no longer leaks (measured for todo 27: bodyExclude bypassed alone leaves x-en at 0
   * leaking items, x-ko at 1). The control therefore bypasses both - `bodyExclude` through the
   * config and the link-wrapper rule by stripping `role="link"` from the markup, the same
   * attribute-removal trick the testid-rename test below uses - and then both files leak. Keeping
   * only the config bypass would have let this canary pass vacuously on x-en.
   */
  const control = (site: SiteId, files: string[]): void => {
    const cfg = SITES[site];
    const broken: SiteConfig = { ...cfg, bodyExclude: ":not(*)" };
    for (const file of files) {
      const raw = readFileSync(join(DIR, file), "utf8");
      expect(raw).toContain(' role="link"');
      const unguarded = new DOMParser().parseFromString(raw.replaceAll(' role="link"', ""), "text/html");
      const unguardedItems = [...unguarded.querySelectorAll(cfg.item)];
      expect(unguardedItems.length).toBeGreaterThan(0);
      const leaking = unguardedItems.filter((el) => extractSignals(el, broken).chromeText.some((s) => s.includes(SENTINEL)));
      expect(leaking.length).toBeGreaterThan(0);
      const items = [...load(file).querySelectorAll(cfg.item)];
      expect(items.length).toBeGreaterThan(0);
      const clean = items.filter((el) => extractSignals(el, cfg).chromeText.some((s) => s.includes(SENTINEL)));
      expect(clean.length).toBe(0);
      // The shipped config holds the line even with one guard's hook removed from the markup.
      const strippedClean = unguardedItems.filter((el) => extractSignals(el, cfg).chromeText.some((s) => s.includes(SENTINEL)));
      expect(strippedClean.length).toBe(0);
    }
  };

  test("with bodyExclude and the link-wrapper guard both bypassed, X chromeText DOES contain the sentinel", () => {
    control("x", ["x-en.html", "x-ko.html"]);
  });

  test("bodyExclude still guards the X follow read on its own (quoted-tweet Follow)", () => {
    // Independent of the link-wrapper rule, which touches only label-slot STRINGS: bypassing
    // bodyExclude alone must still turn the quoted-tweet Follow button into a false suggested mark.
    const cfg = SITES.x;
    const broken: SiteConfig = { ...cfg, bodyExclude: ":not(*)" };
    for (const file of ["x-en.html", "x-ko.html"]) {
      const el = load(file).querySelector('[data-qa-kind="quotedFollow"]')!;
      expect(el.getAttribute("data-qa-expect")).toBe("keep");
      expect(extractSignals(el, broken).followButton).toBe(true);
      expect(deterministic(extractSignals(el, broken), broken)).toEqual({ category: "suggested", p: 1 });
      expect(extractSignals(el, cfg).followButton).toBe(false);
      expect(deterministic(extractSignals(el, cfg), cfg)).toBeNull();
    }
  });

  test("with the bodyExclude filter bypassed, the LinkedIn React follow-in-body negative is marked", () => {
    // The React label slots cannot reach the commentary paragraph, so bodyExclude no longer
    // guards chromeText there - it guards the FOLLOW slot: the negative item's `button.follow`
    // sits inside the body span, and only bodyExclude keeps it from turning an organic post into
    // a suggested one. Bypassing the filter must therefore produce exactly that false mark.
    const cfg = SITES.linkedin;
    const broken: SiteConfig = { ...cfg, bodyExclude: ":not(*)" };
    for (const file of ["linkedin-react-en.html", "linkedin-react-ko.html"]) {
      const el = load(file).querySelector('[data-qa-kind="bodyFollow"]')!;
      expect(el.getAttribute("data-qa-expect")).toBe("keep");
      expect(extractSignals(el, broken).followButton).toBe(true);
      expect(deterministic(extractSignals(el, broken), broken)).toEqual({ category: "suggested", p: 1 });
      expect(extractSignals(el, cfg).followButton).toBe(false);
      expect(deterministic(extractSignals(el, cfg), cfg)).toBeNull();
    }
  });

  test("post text stays out of descriptors even when the body testid is renamed", () => {
    // Defence in depth. bodyExclude's expandable-text-box entry must not be the ONLY guard: the
    // React label slots must never reach the commentary paragraph in the first place. Strip the
    // body testid - a rename LinkedIn can ship any day - and no descriptor field may carry body
    // text. This fails with a general-sibling (`h2 ~ p[componentkey]`) slot, which admits the
    // paragraph wrapping the body span, and passes with the adjacent-sibling (`h2 + ...`) form.
    const cfg = SITES.linkedin;
    for (const file of ["linkedin-react-en.html", "linkedin-react-ko.html"]) {
      const html = readFileSync(join(DIR, file), "utf8").replaceAll(' data-testid="expandable-text-box"', "");
      expect(html).not.toContain("expandable-text-box");
      const doc = new DOMParser().parseFromString(html, "text/html");
      const items = [...doc.querySelectorAll(cfg.item)];
      expect(items.length).toBeGreaterThanOrEqual(18);
      expect(doc.body.innerHTML).toContain(SENTINEL);
      const leaks: string[] = [];
      items.forEach((el, i) => {
        const d = toDescriptor(i, el, cfg, extractSignals(el, cfg));
        for (const s of allStrings(d)) if (s.includes(SENTINEL)) leaks.push(`${file}[${i}]: ${s}`);
      });
      expect(leaks).toEqual([]);
    }
  });

  test("dropping [componentkey] from the React actor slot leaks the author headline", () => {
    // The keyless sibling paragraph of the React actor sub-description is the author headline
    // (author bio, up to 197 chars live). bodyExclude cannot reach it, so the slot qualifier is
    // the only thing keeping it out of a request: widening the slot must leak the sentinel.
    const widened: SiteConfig = { ...SITES.linkedin, labelSlots: `${SITES.linkedin.labelSlots}, h2 + div p` };
    for (const file of ["linkedin-react-en.html", "linkedin-react-ko.html"]) {
      const items = [...load(file).querySelectorAll(SITES.linkedin.item)];
      const leaking = items.filter((el) => extractSignals(el, widened).chromeText.some((s) => s.includes(SENTINEL)));
      expect(leaking.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Instagram's live feed renders no `<header>` element at all, so both legacy label slots matched 0
 * elements and every ad- or suggested-labelled item was kept
 * (.omo/evidence/live-recheck-2026-10-30.md finding I1). On the live markup the label line is a
 * dir-less `<span>` under `span[dir="auto"] > div` inside the account row, the account NAME is the
 * same shape wrapped in the profile link, and the caption's own text element is a
 * `span[dir="auto"]` nested inside another one. Two guards keep post text out of a request: the
 * `:not([dir])` qualifier on the slot and the matching bodyExclude entry. Both key off the same
 * `dir` attribute, so they are defence in depth against a SELECTOR regression (one of them being
 * dropped), which is what the matrix below pins.
 * The attribution pill is the second source, and the one bodyExclude alone covers: its span IS
 * slot-shaped, and its label is part of the profile link beside it, which is why a doubly-nested
 * `div[data-interactable]` region is never read.
 */
describe("Instagram live markup (no <header>)", () => {
  const cfg = SITES.instagram;
  /** labelSlots without the `:not([dir])` qualifier: the caption's text element becomes a slot. */
  const widened: SiteConfig = { ...cfg, labelSlots: `${cfg.labelSlots}, article span[dir="auto"] span` };
  const bypassed: SiteConfig = { ...cfg, bodyExclude: ":not(*)" };

  for (const file of ["instagram-live-en.html", "instagram-live-ko.html"]) {
    test(`${file}: header-less markup - the legacy slots match nothing and the new one matches`, () => {
      const doc = load(file);
      expect(doc.querySelectorAll("header").length).toBe(0);
      expect(doc.querySelectorAll('article header span, article header a[role="link"] + div span').length).toBe(0);
      expect(doc.querySelectorAll("article header button").length).toBe(0);
      expect(doc.querySelectorAll(cfg.labelSlots).length).toBe(57);
    });

    test(`${file}: the marker justifies the verdict and the account name never reaches chromeText`, () => {
      const doc = load(file);
      const items = [...doc.querySelectorAll(cfg.item)];
      expect(items.length).toBe(19);
      const problems: string[] = [];
      items.forEach((el, i) => {
        const sig = extractSignals(el, cfg);
        const chrome = sig.chromeText.join("|");
        // The account name sits in the slot-shaped span inside the profile link.
        const name = (el.querySelector('span[dir="auto"] a[role="link"] span')?.textContent ?? "").trim();
        if (name.length < 5) problems.push(`${file}[${i}] has no account-name slot`);
        if (chrome.includes(name)) problems.push(`${file}[${i}] chromeText carries the account name`);
        if (sig.withheldSlots < 1) problems.push(`${file}[${i}] withheld nothing`);
        const verdict = deterministic(sig, cfg);
        if (el.getAttribute("data-qa-expect") === "hide") {
          if (verdict === null) problems.push(`${file}[${i}] hide but undecided`);
          else if (sig.chromeText.length === 0 && !sig.followButton) problems.push(`${file}[${i}] verdict with no chrome`);
        } else if (verdict !== null) problems.push(`${file}[${i}] ${el.getAttribute("data-qa-expect")} but ${verdict.category}`);
      });
      expect(problems).toEqual([]);
      const adItem = items.find((el) => el.getAttribute("data-qa-kind") === "adLabel")!;
      const adSignals = extractSignals(adItem, cfg);
      expect(adSignals.adLabel).toBe(true);
      expect(matchesWord(adSignals.chromeText.join(""), AD_WORDS)).toBe(true);
      const suggestedItem = items.find((el) => el.getAttribute("data-qa-kind") === "suggestedLabel")!;
      expect(matchesWord(extractSignals(suggestedItem, cfg).chromeText.join(""), SUGGESTED_WORDS)).toBe(true);
    });

    test(`${file}: the attribution line is a slot that is matched and never read`, () => {
      const doc = load(file);
      const organic = [...doc.querySelectorAll(cfg.item)].filter((el) => el.getAttribute("data-qa-kind") === "organic");
      expect(organic.length).toBeGreaterThan(5);
      for (const el of organic) {
        const sig = extractSignals(el, cfg);
        expect(el.querySelectorAll(cfg.labelSlots).length).toBeGreaterThan(1);
        // Nothing is read, yet the item is still distinguishable from a contentless one, so
        // src/scan.ts keeps asking the model about it (todo 27 finding F1).
        expect(sig.chromeText).toEqual([]);
        expect(sig.withheldSlots).toBeGreaterThan(0);
      }
      // The line itself is slot-shaped: bodyExclude, not the slot selector, is what drops it.
      const line = organic[0]!.querySelector('span[dir="auto"] > span')!;
      expect(line.matches(cfg.labelSlots)).toBe(true);
      expect(line.closest(cfg.bodyExclude)).not.toBeNull();
      // A marker sits one <div> deeper, where bodyExclude cannot reach it.
      const markerSlot = doc.querySelector('[data-qa-kind="adLabel"] span[dir="auto"] > div > span')!;
      expect(markerSlot.matches(cfg.labelSlots)).toBe(true);
      expect(markerSlot.closest(cfg.bodyExclude)).toBeNull();
      expect(matchesWord(markerSlot.textContent ?? "", AD_WORDS)).toBe(true);
    });

    test(`${file}: each guard is load-bearing for the source it covers`, () => {
      const doc = load(file);
      const caption = doc.querySelector('[data-qa-body="caption"]')!;
      const pill = doc.querySelector('div[data-interactable] div[data-interactable] span[dir="auto"] span')!;
      const cut = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      expect(caption.textContent).toContain(SENTINEL);
      expect(pill.textContent).toContain(SENTINEL);
      // The caption becomes a slot the moment the `:not([dir])` qualifier goes; the pill's span is
      // ALREADY slot-shaped and bodyExclude's nested-region entry is the only thing holding it.
      expect([...doc.querySelectorAll(widened.labelSlots)]).toContain(caption);
      expect([...doc.querySelectorAll(cfg.labelSlots)]).not.toContain(caption);
      expect([...doc.querySelectorAll(cfg.labelSlots)]).toContain(pill);
      expect(caption.matches(cfg.bodyExclude)).toBe(true);
      expect(pill.closest(cfg.bodyExclude)).not.toBeNull();
      // The pill's label is part of the profile link beside it - the live shape that made this
      // region a leak in the first place.
      expect(pill.closest("div[data-interactable]")!.querySelector('a[role="link"]')!.textContent).toContain(cut(pill));
      const sentinelStrings = (config: SiteConfig): string[] =>
        [...load(file).querySelectorAll(config.item)]
          .flatMap((el) => extractSignals(el, config).chromeText)
          .filter((s) => s.includes(SENTINEL));
      expect(sentinelStrings(cfg)).toEqual([]);
      // Failing control 1: bodyExclude bypassed - the attribution pill lands in chrome_text, which
      // is what gets sent on a cache miss. The caption still does not: the qualifier holds alone.
      const withoutBodyExclude = sentinelStrings(bypassed);
      expect(withoutBodyExclude).toContain(cut(pill));
      expect(withoutBodyExclude).not.toContain(cut(caption));
      // Failing control 2: the slot qualifier dropped - bodyExclude still keeps the caption out.
      expect(sentinelStrings(widened)).toEqual([]);
      expect(sentinelStrings({ ...widened, bodyExclude: ":not(*)" })).toContain(cut(caption));
    });

    test(`${file}: the account-row Follow control alone marks a not-followed post as suggested`, () => {
      const el = load(file).querySelector('[data-qa-kind="suggestedFollow"]')!;
      expect(el.getAttribute("data-qa-expect")).toBe("hide");
      const sig = extractSignals(el, cfg);
      expect(sig.followButton).toBe(true);
      expect(sig.adLabel || sig.suggestedLabel).toBe(false);
      expect(deterministic(sig, cfg)).toEqual({ category: "suggested", p: 1 });
    });

    test(`${file}: an in-body Follow control is a signal only once bodyExclude is bypassed`, () => {
      const el = load(file).querySelector('[data-qa-kind="bodyFollow"]')!;
      expect(el.getAttribute("data-qa-expect")).toBe("keep");
      // Non-vacuous: the follow slot does reach it, and only bodyExclude stops the read.
      const inBody = el.querySelector('ul li [role="button"]')!;
      expect(inBody.matches(cfg.followSlot)).toBe(true);
      expect(extractSignals(el, bypassed).followButton).toBe(true);
      expect(deterministic(extractSignals(el, bypassed), bypassed)).toEqual({ category: "suggested", p: 1 });
      expect(extractSignals(el, cfg).followButton).toBe(false);
      expect(deterministic(extractSignals(el, cfg), cfg)).toBeNull();
    });
  }
});

/**
 * Slot text must carry the site's own UI labels and nothing else. Link text inside a chrome slot
 * names an entity - on LinkedIn's React feed the actor slot wraps a `/in/` profile anchor whose
 * text is a member name (12 of 30 and 10 of 31 live slots in two sessions, verbatim in
 * chrome_text every time, up to 37 chars) - and README promises names are never sent. The guard
 * is generic in slotText, so it must cost no marker on any site.
 */
describe("link text inside a label slot never reaches chromeText", () => {
  const make = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };
  /** The live React shape: a keyed actor paragraph, inside the div adjacent to the a11y heading, wrapping the anchor. */
  const reactItem = (slotInner: string): Element =>
    make(
      '<div role="listitem"><div><h2><span>Feed post</span></h2>' +
        `<div><div><p componentkey="urn:li:sub:1">${slotInner}</p></div></div></div></div>`
    );
  const PROFILE = '<a href="https://www.linkedin.com/in/member-1"><span>Member One</span></a>';
  const cfg = SITES.linkedin;

  test("the React actor slot really is the slot under test (non-vacuous)", () => {
    const el = reactItem(`${PROFILE}<span>2h</span>`);
    expect(el.querySelectorAll(cfg.labelSlots).length).toBe(1);
    expect(el.querySelectorAll('p[componentkey] a[href*="/in/"]').length).toBe(1);
  });

  test("a profile anchor beside a timestamp leaves only the timestamp", () => {
    const sig = extractSignals(reactItem(`${PROFILE}<span>2h</span>`), cfg);
    expect(sig.chromeText).toEqual(["2h"]);
    expect(sig.chromeText.join("|")).not.toContain("Member");
    expect(deterministic(sig, cfg)).toBeNull();
  });

  test("the marker beside the anchor is still detected and still justifies the verdict", () => {
    const sig = extractSignals(reactItem(`${PROFILE}<span>Promoted</span>`), cfg);
    expect(sig.adLabel).toBe(true);
    expect(sig.chromeText).toEqual(["Promoted"]);
    expect(deterministic(sig, cfg)).toEqual({ category: "ad", p: 1 });
  });

  test("\ud55c\uad6d\uc5b4 marker beside the anchor survives too", () => {
    const sig = extractSignals(reactItem('<a href="/in/member-1"><span>\ud68c\uc6d0 1</span></a><span>\ud504\ub85c\ubaa8\uc158</span>'), cfg);
    expect(sig.chromeText).toEqual(["\ud504\ub85c\ubaa8\uc158"]);
    expect(deterministic(sig, cfg)).toEqual({ category: "ad", p: 1 });
  });

  test("a slot holding nothing but a profile anchor contributes no string at all", () => {
    const sig = extractSignals(reactItem(PROFILE), cfg);
    expect(sig.chromeText).toEqual([]);
    expect(deterministic(sig, cfg)).toBeNull();
  });

  test("the rule is generic: X social-context link text is skipped and the marker kept", () => {
    const el = make(
      '<div data-testid="cellInnerDiv"><div data-testid="socialContext">' +
        '<a href="/member_one"><span>Member One</span></a><span>Promoted</span></div></div>'
    );
    const sig = extractSignals(el, SITES.x);
    expect(sig.chromeText).toEqual(["Promoted"]);
    expect(deterministic(sig, SITES.x)).toEqual({ category: "ad", p: 1 });
  });

  test("a slot that IS an anchor is still read: only anchors INSIDE a slot are skipped", () => {
    const el = make('<div data-testid="cellInnerDiv"><a data-testid="socialContext" href="/i/promoted">Promoted</a></div>');
    const sig = extractSignals(el, SITES.x);
    expect(sig.chromeText).toEqual(["Promoted"]);
    expect(deterministic(sig, SITES.x)).toEqual({ category: "ad", p: 1 });
  });

  test("a follow button whose label sits beside a profile link still counts", () => {
    const el = make(
      '<div><div class="update-components-actor"><button>' +
        '<a href="/in/member-1">Member One</a><span>Follow</span></button></div></div>'
    );
    expect(extractSignals(el, cfg).followButton).toBe(true);
  });

  for (const file of ["linkedin-react-en.html", "linkedin-react-ko.html"]) {
    test(`${file}: the synthetic actor-slot profile anchor is not read, the marker beside it is`, () => {
      const doc = load(file);
      const nameOnly = doc.querySelector('[data-qa-slot-anchor="name"]')!;
      const withMarker = doc.querySelector('[data-qa-slot-anchor="name-and-marker"]')!;
      const anchorText = (el: Element): string => {
        const anchors = [...el.querySelectorAll('p[componentkey] a[href*="/in/"]')];
        expect(anchors.length).toBe(1);
        const text = (anchors[0]!.textContent ?? "").replace(/\s+/g, " ").trim();
        expect(text.length).toBeGreaterThan(2);
        return text;
      };

      const organic = extractSignals(nameOnly, SITES.linkedin);
      expect(nameOnly.getAttribute("data-qa-expect")).toBe("keep");
      expect(organic.chromeText.join("|")).not.toContain(anchorText(nameOnly));
      expect(deterministic(organic, SITES.linkedin)).toBeNull();

      const ad = extractSignals(withMarker, SITES.linkedin);
      expect(withMarker.getAttribute("data-qa-expect")).toBe("hide");
      expect(ad.chromeText.join("|")).not.toContain(anchorText(withMarker));
      expect(ad.chromeText.length).toBeGreaterThan(0);
      expect(deterministic(ad, SITES.linkedin)).toEqual({ category: "ad", p: 1 });
    });
  }

  test("no chromeText string in any of the 14 fixtures carries link text read from a label slot", () => {
    let linkSlots = 0;
    const leaks: string[] = [];
    for (const { file, site } of ALL_FIXTURES) {
      const siteCfg = SITES[site];
      const doc = load(file);
      [...doc.querySelectorAll(siteCfg.item)].forEach((el, i) => {
        const chrome = extractSignals(el, siteCfg).chromeText.join("|");
        for (const slot of el.querySelectorAll(siteCfg.labelSlots)) {
          const body = slot.closest(siteCfg.bodyExclude);
          if (body !== null && el.contains(body)) continue;
          for (const anchor of slot.querySelectorAll("a[href]")) {
            const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
            if (text.length < 2) continue;
            linkSlots++;
            if (chrome.includes(text)) leaks.push(`${file}[${i}]`);
          }
        }
      });
    }
    expect(leaks).toEqual([]);
    // Non-vacuous: the React fixtures contribute link-bearing slots (2 per file).
    expect(linkSlots).toBeGreaterThanOrEqual(4);
  });

  test("deterministic verdict counts per fixture are unchanged (pinned over all 14 files)", () => {
    const counted: Record<string, { items: number; ad: number; suggested: number; none: number }> = {};
    for (const { file, site } of ALL_FIXTURES) {
      const siteCfg = SITES[site];
      const row = { items: 0, ad: 0, suggested: 0, none: 0 };
      for (const el of load(file).querySelectorAll(siteCfg.item)) {
        row.items++;
        const v = deterministic(extractSignals(el, siteCfg), siteCfg);
        if (v === null) row.none++;
        else if (v.category === "ad") row.ad++;
        else row.suggested++;
      }
      counted[file] = row;
    }
    expect(counted).toEqual(VERDICT_COUNTS);
  });
});

/**
 * The companion case: the slot itself sits INSIDE a link. The nested-anchor rule above only
 * skips anchors found BELOW a slot, so a slot that is a link's descendant was read in full. Live
 * X is exactly that shape: 3 of 3 eligible label slots over three read-only sessions sat inside a
 * profile-shaped link (single path segment, no `<time>`, no digit, the link carrying no text
 * beyond the slot), read up to 27 chars of what can only be a handle or display name
 * (.omo/evidence/aside-feed-declutter-todo-26-gate-review.md finding F3, re-measured for todo 27).
 * The rule: a wrapper-bound slot contributes ONLY an exact marker word, never its free text - so
 * the strings it can still emit are the fixed constants of src/markers.ts, never an identifier.
 */
describe("a label slot inside a link contributes only its marker word", () => {
  const cfg = SITES.x;
  const make = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };
  /** An X cell whose single label slot sits inside `wrap`; `wrap` empty = the no-wrapper control. */
  const xItem = (wrap: string, text: string): Element => {
    const slot = `<div data-testid="socialContext">${text}</div>`;
    const inner = wrap === "" ? slot : `<${wrap}>${slot}</${wrap.split(" ")[0]}>`;
    return make(`<div data-testid="cellInnerDiv">${inner}</div>`);
  };
  /** Synthetic stand-in for the live 27-char read; never a real name. */
  const NAME = "Member One Display Name 123";

  test("control: the same slot outside any link IS read (the rule has something to remove)", () => {
    const el = xItem("", NAME);
    expect(el.querySelectorAll(cfg.labelSlots).length).toBe(1);
    expect(NAME.length).toBe(27);
    expect(extractSignals(el, cfg).chromeText).toEqual([NAME]);
  });

  for (const wrap of [
    'a href="#/member1"',
    'a href="#/member1" role="link"',
    "a",
    'div role="link"',
    'span role="link" tabindex="0"'
  ]) {
    test(`<${wrap}> around the slot: no slot text reaches chromeText`, () => {
      const el = xItem(wrap, NAME);
      expect(el.querySelectorAll(cfg.labelSlots).length).toBe(1);
      const sig = extractSignals(el, cfg);
      expect(sig.chromeText).toEqual([]);
      expect(sig.chromeText.join("|")).not.toContain("Member");
      expect(deterministic(sig, cfg)).toBeNull();
    });

    test(`<${wrap}> around the slot: an exact marker word is still read and still decides`, () => {
      const sig = extractSignals(xItem(wrap, "Promoted"), cfg);
      expect(sig.adLabel).toBe(true);
      expect(sig.chromeText).toEqual(["Promoted"]);
      expect(deterministic(sig, cfg)).toEqual({ category: "ad", p: 1 });
    });
  }

  test("\ud55c\uad6d\uc5b4 and suggested markers survive the wrapper too", () => {
    const ko = extractSignals(xItem('a href="#/member1"', "\uad11\uace0"), cfg);
    expect(ko.chromeText).toEqual(["\uad11\uace0"]);
    expect(deterministic(ko, cfg)).toEqual({ category: "ad", p: 1 });
    const sug = extractSignals(xItem('div role="link"', "\ucd94\ucc9c"), cfg);
    expect(sug.chromeText).toEqual(["\ucd94\ucc9c"]);
    expect(deterministic(sug, cfg)).toEqual({ category: "suggested", p: 1 });
  });

  test("a link several levels above the slot still drops it", () => {
    const el = make(
      '<div data-testid="cellInnerDiv"><a href="#/member1"><div><span>' +
        `<div data-testid="socialContext">${NAME}</div></span></div></a></div>`
    );
    expect(extractSignals(el, cfg).chromeText).toEqual([]);
  });

  test("only wrapper-bound slots are dropped: a sibling slot outside the link is still read", () => {
    const el = make(
      '<div data-testid="cellInnerDiv">' +
        `<a href="#/member1"><div data-testid="socialContext">${NAME}</div></a>` +
        '<div data-testid="socialContext">2h</div></div>'
    );
    expect(el.querySelectorAll(cfg.labelSlots).length).toBe(2);
    expect(extractSignals(el, cfg).chromeText).toEqual(["2h"]);
  });

  test("a link ABOVE the item is never consulted: the walk stops at the item root", () => {
    const outer = make(`<a href="#/member1"><div data-testid="cellInnerDiv"><div data-testid="socialContext">2h</div></div></a>`);
    const item = outer.querySelector('[data-testid="cellInnerDiv"]')!;
    expect(extractSignals(item, cfg).chromeText).toEqual(["2h"]);
  });

  test("the follow read is untouched: a FOLLOW label inside a link still counts", () => {
    const el = make('<div data-testid="cellInnerDiv"><a href="#/member1"><button data-testid="42-follow">Follow</button></a></div>');
    const sig = extractSignals(el, cfg);
    expect(sig.followButton).toBe(true);
    expect(deterministic(sig, cfg)).toEqual({ category: "suggested", p: 1 });
  });

  /**
   * `withheldSlots` is why an emptied slot is not the same thing as a missing one. `src/scan.ts`
   * keeps an item with no chrome at all local instead of spending budget on it; without this
   * counter that branch would read a slot this rule silenced as "this card has no chrome" and stop
   * asking the model about it (todo 27 gate finding F1, measured on Instagram: 13 of 19 items per
   * fixture). It is internal to the scanner: `toDescriptor` lists the wire fields explicitly, so it
   * is never sent.
   */
  test("withheldSlots counts exactly the slots whose text was withheld", () => {
    expect(extractSignals(xItem("", NAME), cfg).withheldSlots).toBe(0);
    expect(extractSignals(xItem('a href="#/member1"', NAME), cfg).withheldSlots).toBe(1);
    expect(extractSignals(xItem('div role="link"', NAME), cfg).withheldSlots).toBe(1);
    // A marker is kept, so nothing was withheld.
    expect(extractSignals(xItem('a href="#/member1"', "Promoted"), cfg).withheldSlots).toBe(0);
    // An empty slot is dropped before the rule can see it: nothing was withheld there either.
    expect(extractSignals(xItem('a href="#/member1"', "   "), cfg).withheldSlots).toBe(0);
    const two = make(
      '<div data-testid="cellInnerDiv">' +
        `<a href="#/member1"><div data-testid="socialContext">${NAME}</div></a>` +
        `<a href="#/member2"><div data-testid="socialContext">${NAME}</div></a>` +
        '<div data-testid="socialContext">2h</div></div>'
    );
    const sig = extractSignals(two, cfg);
    expect(sig.withheldSlots).toBe(2);
    expect(sig.chromeText).toEqual(["2h"]);
  });

  test("every withheld slot across the 14 fixtures is counted, and only Instagram has any", () => {
    const counted: Record<string, number> = {};
    for (const { file, site } of ALL_FIXTURES) {
      const siteCfg = SITES[site];
      let withheld = 0;
      for (const el of load(file).querySelectorAll(siteCfg.item)) withheld += extractSignals(el, siteCfg).withheldSlots;
      counted[file] = withheld;
    }
    expect(counted).toEqual({
      "youtube-en.html": 0,
      "youtube-ko.html": 0,
      "x-en.html": 0,
      "x-ko.html": 0,
      "x-messages-en.html": 0,
      "stress-x-en.html": 0,
      "instagram-en.html": 19,
      "instagram-ko.html": 19,
      "instagram-live-en.html": 19,
      "instagram-live-ko.html": 19,
      "linkedin-en.html": 0,
      "linkedin-ko.html": 0,
      "linkedin-react-en.html": 0,
      "linkedin-react-ko.html": 0
    });
  });

  for (const file of ["instagram-en.html", "instagram-ko.html"]) {
    test(`${file}: an item the rule silenced is distinguishable from an item with no chrome`, () => {
      // The two inputs src/scan.ts needs to tell apart. Every undecided Instagram item has an
      // empty chrome_text AND a withheld slot, so it must still be asked about; an item with
      // neither is genuinely contentless and stays local.
      const siteCfg = SITES.instagram;
      const undecided = [...load(file).querySelectorAll(siteCfg.item)]
        .map((el) => extractSignals(el, siteCfg))
        .filter((sig) => deterministic(sig, siteCfg) === null);
      expect(undecided.length).toBe(13);
      for (const sig of undecided) {
        expect(sig.chromeText).toEqual([]);
        expect(sig.withheldSlots).toBeGreaterThan(0);
      }
    });
  }

  test("no chromeText string in any of the 14 fixtures carries text read from a wrapper-bound slot", () => {
    const WRAP = 'a, [role="link"]';
    let wrapped = 0;
    let markerWrapped = 0;
    const leaks: string[] = [];
    for (const { file, site } of ALL_FIXTURES) {
      const siteCfg = SITES[site];
      [...load(file).querySelectorAll(siteCfg.item)].forEach((el, i) => {
        const chrome = extractSignals(el, siteCfg).chromeText;
        for (const slot of el.querySelectorAll(siteCfg.labelSlots)) {
          if (slot.closest(siteCfg.bodyExclude) !== null) continue;
          let wrapper: Element | null = null;
          for (let cur = slot.parentElement; cur !== null; cur = cur.parentElement) {
            if (cur.matches(WRAP)) {
              wrapper = cur;
              break;
            }
            if (cur === el) break;
          }
          if (wrapper === null) continue;
          wrapped++;
          const text = (slot.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
          if (text.length < 2) continue;
          if (matchesWord(text, [...AD_WORDS, ...SUGGESTED_WORDS])) {
            markerWrapped++;
            expect(chrome).toContain(text);
            continue;
          }
          if (chrome.some((s) => s === text)) leaks.push(`${file}[${i}]`);
        }
      });
    }
    expect(leaks).toEqual([]);
    // Non-vacuous: Instagram's account-name slots sit inside the account's profile link - 19 per
    // fixture, 76 over the fourteen files (legacy header markup and live markup alike), measured
    // for todo 27 and re-measured for todo 28. None of them holds a marker, so the marker branch
    // above is a guard for future markup, not the thing proving the zero.
    expect(wrapped).toBeGreaterThanOrEqual(76);
    expect(markerWrapped).toBe(0);
  });
});

describe("malformed input", () => {
  const cfg = SITES.x;
  const make = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  test("item with no slots", () => {
    const el = make('<div data-testid="cellInnerDiv"></div>');
    const sig = extractSignals(el, cfg);
    expect(sig).toEqual({
      adAttribute: false,
      adLabel: false,
      suggestedLabel: false,
      followButton: false,
      chromeText: [],
      withheldSlots: 0,
      hasExternalLink: false,
      media: "none"
    });
    expect(deterministic(sig, cfg)).toBeNull();
  });

  test("label slot with empty or whitespace text is dropped", () => {
    const el = make('<div><div data-testid="socialContext"><span>  </span><span></span></div></div>');
    const sig = extractSignals(el, cfg);
    expect(sig.chromeText).toEqual([]);
    expect(deterministic(sig, cfg)).toBeNull();
  });

  test("500-level nested item does not throw", () => {
    const el = make("<div>" + "<div>".repeat(500) + '<div data-testid="socialContext"><span>Promoted</span></div>' + "</div>".repeat(500) + "</div>");
    expect(() => extractSignals(el, cfg)).not.toThrow();
    expect(extractSignals(el, cfg).adLabel).toBe(true);
  });

  test("item with 1000 label slots does not throw and keeps at most 8 strings", () => {
    const el = make("<div>" + '<div data-testid="socialContext"><span>label</span></div>'.repeat(1000) + "</div>");
    const sig = extractSignals(el, cfg);
    expect(sig.chromeText.length).toBe(8);
  });

  test("one slot holding 1000 text nodes bounds the number of text reads", () => {
    const el = make('<div><div data-testid="socialContext"><span id="s"></span></div></div>');
    const span = el.querySelector("#s")!;
    let reads = 0;
    for (let i = 0; i < 1000; i++) {
      const t = document.createTextNode("abcdefghij");
      for (const prop of ["data", "textContent", "nodeValue", "wholeText"]) {
        Object.defineProperty(t, prop, {
          get() {
            reads++;
            return "abcdefghij";
          }
        });
      }
      span.appendChild(t);
    }
    const sig = extractSignals(el, cfg);
    expect(sig.chromeText[0]!.length).toBe(40);
    expect(reads).toBeLessThan(100);
  });

  test("300 body-excluded label spans before a real Ad label do not hide it", () => {
    const body = '<div data-testid="tweetText">' + "<span>filler</span>".repeat(300) + "</div>";
    const el = make(`<div><div data-testid="User-Name"></div>${body}<div data-testid="socialContext"><span>Ad</span></div></div>`);
    const sig = extractSignals(el, cfg);
    expect(sig.adLabel).toBe(true);
    expect(sig.chromeText).toContain("Ad");
    expect(sig.chromeText).not.toContain("filler");
    expect(deterministic(sig, cfg)).toEqual({ category: "ad", p: 1 });
  });

  test("external anchor after 300 local anchors is still found", () => {
    const el = make(
      "<div>" + '<a href="/local">l</a>'.repeat(300) + '<a href="https://example.com/out">o</a></div>'
    );
    expect(extractSignals(el, cfg).hasExternalLink).toBe(true);
  });

  test("long label is cut to 40 chars", () => {
    const el = make(`<div><div data-testid="socialContext"><span>${"x".repeat(100)}</span></div></div>`);
    expect(extractSignals(el, cfg).chromeText[0]!.length).toBe(40);
  });

  test("descriptor has the declared shape and a stable key", () => {
    const el = make('<div><div data-testid="socialContext"><span>Sponsored</span></div><video></video></div>');
    const sig = extractSignals(el, cfg);
    const d = toDescriptor(3, el, cfg, sig);
    expect(d.n).toBe(3);
    expect(d.chrome_text).toEqual(["Sponsored"]);
    expect(d.media).toBe("video");
    expect(d.signature.startsWith("x:")).toBe(true);
    expect(d.key).toBe(toDescriptor(9, el, cfg, sig).key);
  });
});
