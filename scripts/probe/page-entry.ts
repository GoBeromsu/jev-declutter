import { SITES } from "../../src/sites";
import { countDrift, type DriftCounts } from "./linkedin-count";

const CFG = SITES.linkedin;
const SCROLLER = "main#workspace";

interface PageProbe {
  items(): number;
  scroll(px: number): boolean;
  count(root?: ParentNode): DriftCounts;
}

const probe: PageProbe = {
  items: () => document.querySelectorAll(CFG.item).length,
  scroll: (px) => {
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
