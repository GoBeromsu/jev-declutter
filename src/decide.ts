import type { Action, Category, Settings } from "./types";

// Rules live in code, not in the prompt: change a threshold here and only rendering reruns.
export const HIDE_AT = 0.8;
export const BLUR_AT = 0.5;

/** Each category is either hidden or left alone: blur is not a setting, it is the "unsure" state. */
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

/** On screen once the page has painted. A NaN top is never trusted to be off-screen. */
export function onScreen(pos: Placement): boolean {
  return Number.isNaN(pos.top) || (pos.pageHasPainted && !(pos.top >= Math.max(0, pos.viewportHeight)));
}

export const ITEM_CSS =
  '[data-jev="hide"]{display:none!important}' +
  '[data-jev="blur"]{filter:blur(10px)!important;opacity:.4!important;pointer-events:none!important;contain:paint!important}';

/** Local calendar day, so the cache rolls over at the user's midnight. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
