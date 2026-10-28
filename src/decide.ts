import type { Action, Decision } from "./types";

// Rules live in code, not in the prompt: change a threshold here and only rendering reruns.
export const ESSENTIAL_AT = 0.5;
export const HIDE_AT = 0.8;
export const BLUR_AT = 0.5;

export function decide(distracting: number, essential: number): Action {
  if (essential >= ESSENTIAL_AT) return "keep";
  if (distracting >= HIDE_AT) return "hide";
  if (distracting >= BLUR_AT) return "blur";
  return "keep";
}

const RULES: Record<Exclude<Action, "keep">, string> = {
  hide: "display: none !important;",
  blur: "filter: blur(14px) grayscale(1) !important; opacity: 0.5 !important; pointer-events: none !important;"
};

/** Same decisions in, byte-identical CSS out: sorted and free of timestamps. */
export function renderCss(decisions: Decision[]): string {
  return decisions
    .filter((d) => d.action !== "keep")
    .map((d) => ({ selector: d.selector, action: d.action as Exclude<Action, "keep"> }))
    .sort((a, b) => a.selector.localeCompare(b.selector))
    .map((d) => `${d.selector} { ${RULES[d.action]} }`)
    .join("\n");
}

/** Local calendar day, so the cache rolls over at the user's midnight. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
