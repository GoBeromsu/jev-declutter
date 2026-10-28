import type { Signals } from "./signals";
import type { SiteConfig } from "./sites";
import type { Category } from "./types";

/** Local verdict from UI-chrome signals alone; null = undecided (model or keep). */
export function deterministic(sig: Signals, cfg: SiteConfig): { category: Category; p: 1 } | null {
  if (sig.adAttribute || sig.adLabel) return { category: "ad", p: 1 };
  if (sig.suggestedLabel || (sig.followButton && cfg.followMeansSuggested)) return { category: "suggested", p: 1 };
  return null;
}
