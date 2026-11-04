import type { Action, Category, Settings } from "./types";

export const HIDE_AT = 0.8;
export const BLUR_AT = 0.5;

export function actionsOf({ hideAds, hideSuggested }: Pick<Settings, "hideAds" | "hideSuggested">): Record<Category, Action> {
  return { ad: hideAds ? "hide" : "keep", suggested: hideSuggested ? "hide" : "keep" };
}

export function actionFor(category: Category, p: number | null, actions: Record<Category, Action>): Action {
  if (p === null || !(p >= BLUR_AT)) return "keep";
  const want = actions[category];
  if (want === "keep") return "keep";
  if (p >= HIDE_AT) return want;
  return "blur";
}

const RANK: Record<Action, number> = { keep: 0, blur: 1, hide: 2 };

export function combine(a: Action, b: Action): Action {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface Placement {
  pageHasPainted: boolean;
  top: number;
  viewportHeight: number;
}

export function onScreen(pos: Placement): boolean {
  return Number.isNaN(pos.top) || (pos.pageHasPainted && !(pos.top >= Math.max(0, pos.viewportHeight)));
}

export interface ReadingPosition {
  top: number;
  scrollY: number;
}

export function readingDrift(before: ReadingPosition, after: ReadingPosition, collapsedAbove: number): number {
  if (after.scrollY !== before.scrollY) return 0;
  const drift = after.top - before.top;
  return drift < -0.5 ? Math.max(drift, -collapsedAbove) : 0;
}

export const ITEM_CSS =
  '[data-jev="hide"]{display:none!important}' +
  '[data-jev="blur"]:not([role="presentation"]){filter:blur(10px)!important;opacity:.4!important;pointer-events:none!important;contain:paint!important}' +
  '[data-jev="blur"][role="presentation"] [aria-label] img{filter:blur(10px)!important}' +
  '[data-jev="blur"]{transition:filter .18s ease-out,opacity .18s ease-out!important}' +
  '@media (prefers-reduced-motion:reduce){[data-jev="blur"]{transition:opacity .12s linear!important}}';

export const COLLAPSE_CSS =
  '[data-jev="hide"]{display:block!important;height:0!important;overflow:hidden!important;padding:0!important;margin:0!important;visibility:hidden!important}';

export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
