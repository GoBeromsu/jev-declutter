import type { Action, Category } from "./types";

// Rules live in code, not in the prompt: change a threshold here and only rendering reruns.
export const HIDE_AT = 0.8;
export const BLUR_AT = 0.5;

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

/**
 * A hide only applies where nothing on screen moves: below the viewport, or before
 * the first paint. In view or above (after paint) it degrades to blur. A NaN top is
 * never trusted to be off-screen, so it also degrades to blur.
 */
export function placement(want: Action, pos: Placement): Action {
  if (want !== "hide") return want;
  if (Number.isNaN(pos.top)) return "blur";
  if (pos.top >= Math.max(0, pos.viewportHeight)) return "hide";
  return pos.pageHasPainted ? "blur" : "hide";
}

export const ITEM_CSS =
  '[data-jev="hide"]{display:none!important}' +
  '[data-jev="blur"]{filter:blur(10px)!important;opacity:.4!important;pointer-events:none!important;contain:paint!important}';

/** Local calendar day, so the cache rolls over at the user's midnight. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
