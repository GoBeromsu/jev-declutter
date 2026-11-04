import type { Action, Category } from "./types";

// Rules live in code, not in the prompt: change a threshold here and only rendering reruns.
export const HIDE_AT = 0.8;
export const BLUR_AT = 0.5;

/** Ads are never a choice. A recommendation is either hidden or left alone: blur is not a setting, it is the "unsure" state. */
export function actionsOf(hideSuggested: boolean): Record<Category, Action> {
  return { ad: "hide", suggested: hideSuggested ? "hide" : "keep" };
}

export function actionFor(category: Category, p: number | null, actions: Record<Category, Action>): Action {
  if (p === null || !(p >= BLUR_AT)) return "keep";
  const want = actions[category];
  if (want === "keep") return "keep";
  if (p >= HIDE_AT) return want;
  return "blur";
}

const RANK: Record<Action, number> = { keep: 0, blur: 1, cover: 2, hide: 3 };

export function combine(a: Action, b: Action): Action {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface Placement {
  pageHasPainted: boolean;
  top: number;
  viewportHeight: number;
}

/**
 * A hide collapses only where nothing on screen moves: below the viewport, or before the
 * first paint. In view or above (after paint) it becomes a cover: same box, nothing of the
 * content visible or clickable. A NaN top is never trusted to be off-screen, so it covers too.
 */
export function placement(want: Action, pos: Placement): Action {
  if (want !== "hide") return want;
  if (Number.isNaN(pos.top)) return "cover";
  if (pos.top >= Math.max(0, pos.viewportHeight)) return "hide";
  return pos.pageHasPainted ? "cover" : "hide";
}

// The cover keeps the item's own box (no position change: virtualized feeds place items
// absolutely) and hides every child. The label is a background image, so it takes no layout;
// a page CSP that blocks data: images leaves the plain tint.
const COVER_LABEL = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='24'>" +
  "<text x='60' y='16' text-anchor='middle' font-family='system-ui,sans-serif' font-size='12' fill='#888'>숨김</text></svg>"
);

export const ITEM_CSS =
  '[data-jev="hide"]{display:none!important}' +
  `[data-jev="cover"]{background:rgba(128,128,128,.12) url("data:image/svg+xml,${COVER_LABEL}") center/120px 24px no-repeat!important;` +
  'pointer-events:none!important;user-select:none!important;contain:paint!important}' +
  '[data-jev="cover"]>*{visibility:hidden!important}' +
  '[data-jev="blur"]{filter:blur(10px)!important;opacity:.4!important;pointer-events:none!important;contain:paint!important}';

/** Local calendar day, so the cache rolls over at the user's midnight. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
