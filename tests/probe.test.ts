import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER_MAX_CHARS, countDrift, headerMarkers, type DriftCounts } from "../scripts/probe/linkedin-count";
import { buildPageBundle } from "../scripts/probe/linkedin";
import { AD_WORDS, SUGGESTED_WORDS } from "../src/markers";
import { SITES, type SiteConfig } from "../src/sites";

const DIR = join(import.meta.dir, "fixtures");
const CFG = SITES.linkedin;
const REACT = ["linkedin-react-en.html", "linkedin-react-ko.html"];

const load = (file: string): Document =>
  new DOMParser().parseFromString(readFileSync(join(DIR, file), "utf8"), "text/html");

const make = (html: string): Element => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild!;
};

const slots = (cfg: SiteConfig): string[] => cfg.labelSlots.split(",").map((s) => s.trim());

/**
 * THE FAILING CONTROL CONFIG: the shipped LinkedIn config with its React label slots removed -
 * every keyed selector drops out, leaving exactly the four legacy ones the config carried before
 * todo 18. Derived from the shipped value rather than copied, so it cannot drift away from it.
 */
const NO_REACT_SLOTS: SiteConfig = {
  ...CFG,
  labelSlots: slots(CFG)
    .filter((s) => !s.includes("componentkey"))
    .join(", ")
};

/** No label can be read at all: used to prove the ground truth needs no slot whatsoever. */
const NO_SLOTS: SiteConfig = { ...CFG, labelSlots: ":not(*)" };

const EXPECTED: Record<string, DriftCounts> = {
  "linkedin-react-en.html": {
    itemsSeen: 19,
    adMarkerItems: 4,
    adDetected: 4,
    suggestedMarkerItems: 1,
    suggestedDetected: 1,
    organicFalseMarked: 0,
    maxChromeLen: 17
  },
  "linkedin-react-ko.html": {
    itemsSeen: 19,
    adMarkerItems: 4,
    adDetected: 4,
    suggestedMarkerItems: 1,
    suggestedDetected: 1,
    organicFalseMarked: 0,
    maxChromeLen: 10
  }
};

describe("drift probe over the LinkedIn React fixtures", () => {
  test("the control config really is the shipped one minus the React slots", () => {
    expect(slots(CFG)).toContain("h2 + div p[componentkey]");
    expect(slots(CFG)).toContain("h2 + p[componentkey]");
    expect(slots(NO_REACT_SLOTS)).toHaveLength(4);
    expect(NO_REACT_SLOTS.labelSlots).not.toContain("componentkey");
    expect(NO_REACT_SLOTS.bodyExclude).toBe(CFG.bodyExclude);
    expect(NO_REACT_SLOTS.item).toBe(CFG.item);
  });

  for (const file of REACT) {
    describe(file, () => {
      test("counts are exactly the numbers of record", () => {
        expect(countDrift(load(file), CFG)).toEqual(EXPECTED[file]!);
      });

      test("ACCEPTANCE: every ad marker is detected and no organic item is marked", () => {
        const counts = countDrift(load(file), CFG);
        // Non-vacuous: 0 == 0 must not be able to pass this.
        expect(counts.adMarkerItems).toBeGreaterThan(0);
        expect(counts.itemsSeen).toBeGreaterThanOrEqual(18);
        expect(counts.adDetected).toBe(counts.adMarkerItems);
        expect(counts.organicFalseMarked).toBe(0);
      });

      test("FAILING CONTROL: with the React label slots removed the probe reports a miss", () => {
        const counts = countDrift(load(file), NO_REACT_SLOTS);
        expect(counts.adDetected).toBeLessThan(counts.adMarkerItems);
        expect(counts.adDetected).toBe(0);
        expect(counts.suggestedDetected).toBeLessThan(counts.suggestedMarkerItems);
        // The ground truth is unmoved by the config change - that is what makes the miss visible.
        expect(counts.adMarkerItems).toBe(EXPECTED[file]!.adMarkerItems);
        expect(counts.suggestedMarkerItems).toBe(EXPECTED[file]!.suggestedMarkerItems);
        expect(counts.itemsSeen).toBe(EXPECTED[file]!.itemsSeen);
        // A lost slot must stay fail-open: nothing is marked wrongly, and nothing is read at all.
        expect(counts.organicFalseMarked).toBe(0);
        expect(counts.maxChromeLen).toBe(0);
      });

      test("the ground truth needs no label slot at all", () => {
        const blind = countDrift(load(file), NO_SLOTS);
        expect(blind.adMarkerItems).toBe(EXPECTED[file]!.adMarkerItems);
        expect(blind.suggestedMarkerItems).toBe(EXPECTED[file]!.suggestedMarkerItems);
        expect(blind.adDetected).toBe(0);
      });

      test("body text cannot manufacture a marker", () => {
        const doc = load(file);
        // adSentence/bodyNeg carry marker words inside the post body; bodyFollow carries a
        // Follow button there; injection carries a prompt-injection string.
        for (const kind of ["adSentence", "bodyNeg", "injection", "bodyFollow", "unknown", "organic"]) {
          const el = doc.querySelector(`[data-qa-kind="${kind}"]`)!;
          expect(headerMarkers(el, CFG)).toEqual({ ad: false, suggested: false });
        }
        expect(headerMarkers(doc.querySelector('[data-qa-kind="adLabel"]')!, CFG)).toEqual({
          ad: true,
          suggested: false
        });
        expect(headerMarkers(doc.querySelector('[data-qa-kind="suggestedLabel"]')!, CFG)).toEqual({
          ad: false,
          suggested: true
        });
      });

      test("the returned object is seven numbers and nothing else", () => {
        const counts = countDrift(load(file), CFG);
        expect(Object.keys(counts).sort()).toEqual(
          [
            "adDetected",
            "adMarkerItems",
            "itemsSeen",
            "maxChromeLen",
            "organicFalseMarked",
            "suggestedDetected",
            "suggestedMarkerItems"
          ].sort()
        );
        for (const value of Object.values(counts)) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      });
    });
  }

  test("ko and en fixtures agree on every count except string length", () => {
    const en = countDrift(load("linkedin-react-en.html"), CFG);
    const ko = countDrift(load("linkedin-react-ko.html"), CFG);
    expect({ ...ko, maxChromeLen: 0 }).toEqual({ ...en, maxChromeLen: 0 });
  });
});

describe("the ground-truth region rule", () => {
  const marker = '<p componentkey="urn:li:sub:0"><span>Promoted</span></p>';
  const body = '<span data-testid="expandable-text-box">a post body</span>';

  test("a marker above the body counts", () => {
    expect(headerMarkers(make(`<div>${marker}${body}</div>`), CFG)).toEqual({ ad: true, suggested: false });
  });

  test("the same marker below the body does not (documented gap: it lands in organicFalseMarked)", () => {
    expect(headerMarkers(make(`<div>${body}${marker}</div>`), CFG)).toEqual({ ad: false, suggested: false });
  });

  test("a marker word inside the body container is never read", () => {
    const html = '<div><span data-testid="expandable-text-box">Promoted</span></div>';
    expect(headerMarkers(make(html), CFG)).toEqual({ ad: false, suggested: false });
  });

  test("a sentence containing a marker word does not match; the exact word does", () => {
    const sentence = "<div><p><span>Ad spend is up this quarter</span></p></div>";
    expect(headerMarkers(make(sentence), CFG)).toEqual({ ad: false, suggested: false });
    expect(headerMarkers(make("<div><p><span> AD </span></p></div>"), CFG)).toEqual({ ad: true, suggested: false });
  });

  test("a Korean suggested marker counts", () => {
    expect(headerMarkers(make("<div><p><span>회원님을 위한 추천</span></p></div>"), CFG)).toEqual({
      ad: false,
      suggested: true
    });
  });

  test("an item with no body container is still scanned", () => {
    expect(headerMarkers(make(`<div>${marker}</div>`), CFG)).toEqual({ ad: true, suggested: false });
  });

  test("deep nesting does not overflow the walk", () => {
    const deep = `<div>${"<div>".repeat(500)}${marker}${"</div>".repeat(500)}</div>`;
    expect(headerMarkers(make(deep), CFG)).toEqual({ ad: true, suggested: false });
  });

  test("no marker word is longer than the probe's short-text cut", () => {
    for (const word of [...AD_WORDS, ...SUGGESTED_WORDS]) {
      expect(word.length).toBeLessThanOrEqual(MARKER_MAX_CHARS);
    }
  });
});

describe("what the counts mean on legacy LinkedIn markup", () => {
  test("structural ads and follow-only items land in organicFalseMarked, by design", () => {
    // The ground truth is LABEL-based: it cannot see an ad that is marked by an attribute, nor a
    // suggested item that is only a Follow button. The legacy fixtures have 2 of the former and 1
    // of the latter, so they report 3 - which is why this probe is read on the React feed, where
    // adSelectors and followSlot match nothing. Pinned so the asymmetry stays a known quantity.
    for (const file of ["linkedin-en.html", "linkedin-ko.html"]) {
      const doc = load(file);
      expect(doc.querySelectorAll(CFG.adSelectors.join(",")).length).toBe(2);
      const counts = countDrift(doc, CFG);
      expect(counts.adDetected).toBe(counts.adMarkerItems);
      expect(counts.organicFalseMarked).toBe(3);
    }
    for (const file of REACT) {
      const doc = load(file);
      expect(doc.querySelectorAll(CFG.adSelectors.join(",")).length).toBe(0);
      expect(doc.querySelectorAll(CFG.followSlot).length).toBe(1); // the body-nested negative only
    }
  });
});

describe("the browser bundle the runner evaluates", () => {
  test("the bundled page entry produces the same counts as the module", async () => {
    // Proves the maintainer path works, not just the module: build the real IIFE, run it in this
    // global, and compare the global's counts with a direct call.
    const bundle = await buildPageBundle();
    expect(bundle.length).toBeGreaterThan(0);
    new Function(bundle)();
    const probe = (globalThis as unknown as { __jevProbe?: { count(root?: ParentNode): DriftCounts } }).__jevProbe;
    expect(typeof probe?.count).toBe("function");
    for (const file of REACT) {
      expect(probe!.count(load(file))).toEqual(EXPECTED[file]!);
    }
  });
});
