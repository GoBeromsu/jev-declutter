// Browser-side entry of the LinkedIn drift probe. `scripts/probe/linkedin.ts` bundles this file
// into one self-contained IIFE and evaluates it in the live tab; it installs a single global and
// does nothing else. Read-only: it reads the DOM and scrolls, and never clicks, submits, writes
// storage or sends a request.
//
// Nothing here returns page text. `count()` returns the seven numbers of DriftCounts, `items()`
// returns a count and `scroll()` returns whether the feed's own scroll container moved.

import { SITES } from "../../src/sites";
import { countDrift, type DriftCounts } from "./linkedin-count";

const CFG = SITES.linkedin;
/** LinkedIn's React feed renders inside this container; it may or may not be the scrolling box. */
const SCROLLER = "main#workspace";

interface PageProbe {
  items(): number;
  /** Scrolls by `px`; returns true when SCROLLER itself moved, false when the window was scrolled. */
  scroll(px: number): boolean;
  count(root?: ParentNode): DriftCounts;
}

const probe: PageProbe = {
  items: () => document.querySelectorAll(CFG.item).length,
  scroll: (px) => {
    // Decided by effect, not by a style guess: set scrollTop and keep it only if it moved,
    // otherwise the page itself is the scroller.
    const el = document.querySelector(SCROLLER);
    if (el !== null) {
      const before = el.scrollTop;
      el.scrollTop = before + px;
      if (el.scrollTop > before) return true;
    }
    window.scrollBy(0, px);
    return false;
  },
  count: (root = document) => countDrift(root, CFG)
};

(globalThis as unknown as Record<string, PageProbe>).__jevProbe = probe;
