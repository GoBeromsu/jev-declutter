import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AD_WORDS, FOLLOW_WORDS, SUGGESTED_WORDS } from "../src/markers";
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
  { site: "linkedin", prefix: "linkedin" },
  { site: "linkedin", prefix: "linkedin-react" }
];

/**
 * Per-FILE, not per-site: LinkedIn's React markup carries no structural ad attribute and no
 * legacy actor follow slot, so its only follow-slot hit is the body-nested negative control.
 */
const PINNED: Record<string, { ads: number; follows: number }> = {
  "youtube-en.html": { ads: 2, follows: 0 },
  "youtube-ko.html": { ads: 2, follows: 0 },
  "x-en.html": { ads: 2, follows: 2 },
  "x-ko.html": { ads: 2, follows: 2 },
  "instagram-en.html": { ads: 0, follows: 1 },
  "instagram-ko.html": { ads: 0, follows: 1 },
  "linkedin-en.html": { ads: 2, follows: 1 },
  "linkedin-ko.html": { ads: 2, follows: 1 },
  "linkedin-react-en.html": { ads: 0, follows: 1 },
  "linkedin-react-ko.html": { ads: 0, follows: 1 }
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
  const control = (site: SiteId, files: string[]): void => {
    const cfg = SITES[site];
    const broken: SiteConfig = { ...cfg, bodyExclude: ":not(*)" };
    for (const file of files) {
      const items = [...load(file).querySelectorAll(cfg.item)];
      expect(items.length).toBeGreaterThan(0);
      const leaking = items.filter((el) => extractSignals(el, broken).chromeText.some((s) => s.includes(SENTINEL)));
      expect(leaking.length).toBeGreaterThan(0);
      const clean = items.filter((el) => extractSignals(el, cfg).chromeText.some((s) => s.includes(SENTINEL)));
      expect(clean.length).toBe(0);
    }
  };

  test("with the bodyExclude filter bypassed, X chromeText DOES contain the sentinel", () => {
    control("x", ["x-en.html", "x-ko.html"]);
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
