import type { OverrideDecision } from "./overrides";

export interface OverlayRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface OverlayOrigin {
  top: number;
  left: number;
}

interface Placement {
  left: number;
  top: number;
  maxWidth: number;
}

export interface OverlayHost {
  answers(callback: (key: string, decision: OverrideDecision) => void): void;
  origin(): OverlayOrigin;
  show(el: Element, key: string, rect: OverlayRect, origin: OverlayOrigin): void;
  hide(el: Element): void;
  revalidate(): void;
  clear(): void;
}

export const OVERLAY_LAYER_ID = "jev-declutter-layer";

const INSET = 8;

const TEXT = {
  ko: { question: "광고 맞아요?", yes: "예", no: "아니오", label: "이 항목이 광고인지 알려주기" },
  en: { question: "Is this an ad?", yes: "Yes", no: "No", label: "Tell the extension whether this item is an ad" }
} as const;

export function promptLanguage(doc: Document, uiLanguage: string): "ko" | "en" {
  const page = doc.documentElement.getAttribute("lang") ?? "";
  const tag = page.trim() !== "" ? page : uiLanguage;
  return tag.trim().toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function hostColorScheme(doc: Document): "light" | "dark" | "light dark" {
  const view = doc.defaultView;
  for (const el of [doc.body, doc.documentElement]) {
    if (!el || !view) continue;
    const color = view.getComputedStyle(el).backgroundColor;
    if (!color.startsWith("rgb")) continue;
    const [r, g, b, a = 1] = color.match(/[\d.]+/g)?.map(Number) ?? [];
    if (r === undefined || g === undefined || b === undefined || a < 0.5) continue;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
  }
  return "light dark";
}

const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif';

const CSS =
  ".box,.q,button{all:initial;color-scheme:inherit}" +
  ".box{--panel:light-dark(#fff,#22242c);--fg:light-dark(#282632,#eeedf4);--chrome:light-dark(#f0efec,#1e2027);" +
  "--line:light-dark(#dedbe3,#3c3c49);--control-edge:light-dark(#8d8896,#6f6b7d);--accent:light-dark(#7355b6,#c0a8fb);--accent-bg:light-dark(#ede7f7,#39304b);" +
  "--accent-bg-hover:light-dark(#e2d9f3,#453a5b);--shadow:light-dark(#1d17201a,#00000036);" +
  "display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;max-width:100%;" +
  "padding:4px 4px 4px 10px;border:1px solid var(--line);border-radius:10px;background:var(--panel);" +
  "box-shadow:0 2px 10px var(--shadow);animation:settle 180ms cubic-bezier(.2,.7,.2,1)}" +
  `.q{margin-right:4px;color:var(--fg);font:500 12px/1.4 ${FONT};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` +
  `button{flex:none;cursor:pointer;padding:2px 9px;border:1px solid var(--control-edge);border-radius:7px;background:var(--chrome);color:var(--fg);` +
  `font:500 12px/1.4 ${FONT};transition:transform 120ms ease-out}` +
  "button:hover{border-color:var(--fg)}" +
  "button:active{transform:scale(.96)}" +
  'button[data-answer="yes"]{background:var(--accent-bg);border-color:var(--accent);color:var(--accent)}' +
  'button[data-answer="yes"]:hover{background:var(--accent-bg-hover)}' +
  "button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}" +
  "@keyframes settle{from{opacity:0;transform:translateY(2px) scale(.98)}to{opacity:1;transform:none}}" +
  "@keyframes fade{from{opacity:0}to{opacity:1}}" +
  "@media (prefers-reduced-motion:reduce){.box{animation:fade 120ms linear}button{transition:none}}";

const SWALLOWED = [
  "click",
  "auxclick",
  "dblclick",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "keydown",
  "keyup",
  "contextmenu"
] as const;

export function createOverlay(
  answer: (key: string, decision: OverrideDecision) => void,
  doc: Document = document,
  uiLanguage: string = typeof navigator === "undefined" ? "" : navigator.language
): OverlayHost {
  let sink = answer;
  let layer: HTMLElement | undefined;
  let frame = 0;
  let colorScheme: ReturnType<typeof hostColorScheme> = "light dark";
  const prompts = new Map<Element, { host: HTMLElement; key: string; at: Placement }>();

  function ensureLayer(): HTMLElement {
    if (layer?.isConnected === true) return layer;
    const next = doc.createElement("div");
    next.id = OVERLAY_LAYER_ID;
    next.style.cssText =
      "position:absolute;top:0px;left:0px;width:0px;height:0px;margin:0;padding:0;border:0;" +
      "pointer-events:none;z-index:2147483647";
    (doc.body ?? doc.documentElement).append(next);
    layer = next;
    return next;
  }

  function fadeBackIn(item: Element) {
    const reduced = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    item.animate?.(
      reduced ? [{ offset: 0, opacity: 0.4 }] : [{ offset: 0, opacity: 0.4, filter: "blur(10px)" }],
      { duration: reduced ? 120 : 220, easing: "ease-out" }
    );
  }

  function build(key: string): HTMLElement {
    const host = doc.createElement("div");
    host.setAttribute("data-jev-overlay", "");
    host.setAttribute("data-jev-key", key);
    const shadow = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = CSS;
    const text = TEXT[promptLanguage(doc, uiLanguage)];
    const box = doc.createElement("div");
    box.className = "box";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", text.label);
    const question = doc.createElement("span");
    question.className = "q";
    question.textContent = text.question;
    box.append(question);
    for (const [name, decision, label] of [
      ["yes", "confirmed", text.yes],
      ["no", "keep", text.no]
    ] as const) {
      const button = doc.createElement("button");
      button.type = "button";
      button.setAttribute("data-answer", name);
      button.textContent = label;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const live = anchored(host);
        const released = decision === "keep" ? [...prompts].find(([, prompt]) => prompt.host === host)?.[0] : undefined;
        remove(host);
        if (live) {
          if (released?.getAttribute("data-jev") === "blur") fadeBackIn(released);
          sink(key, decision);
        }
      });
      box.append(button);
    }
    for (const type of SWALLOWED) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
    shadow.append(style, box);
    return host;
  }

  function remove(host: HTMLElement) {
    for (const [el, prompt] of prompts) if (prompt.host === host) prompts.delete(el);
    host.remove();
    if (prompts.size === 0) stopWatching();
  }

  function place(rect: OverlayRect, origin: OverlayOrigin): Placement {
    const inset = Math.min(INSET, rect.width / 4, rect.height / 4);
    return {
      left: rect.left - origin.left + inset,
      top: rect.top - origin.top + inset,
      maxWidth: Math.max(0, rect.width - inset * 2)
    };
  }

  function drifted(el: Element, at: Placement, origin: OverlayOrigin): boolean {
    if (!el.isConnected) return true;
    const rect = el.getBoundingClientRect();
    const now = place({ top: rect.top, left: rect.left, width: rect.width, height: rect.height }, origin);
    return Math.abs(now.left - at.left) > 1 || Math.abs(now.top - at.top) > 1 ||
      Math.abs(now.maxWidth - at.maxWidth) > 1;
  }

  function layerOrigin(): OverlayOrigin {
    const rect = ensureLayer().getBoundingClientRect();
    return { top: rect.top, left: rect.left };
  }

  function anchored(host: HTMLElement): boolean {
    const entry = [...prompts].find(([, prompt]) => prompt.host === host);
    if (!entry) return false;
    return !drifted(entry[0], entry[1].at, layerOrigin());
  }

  function revalidate() {
    if (prompts.size === 0) return;
    const origin = layerOrigin();
    for (const [el, prompt] of Array.from(prompts)) if (drifted(el, prompt.at, origin)) remove(prompt.host);
  }

  function watch() {
    const view = doc.defaultView;
    if (frame !== 0 || view === null) return;
    const tick = () => {
      frame = view.requestAnimationFrame(tick);
      revalidate();
    };
    frame = view.requestAnimationFrame(tick);
  }

  function stopWatching() {
    const view = doc.defaultView;
    if (frame !== 0 && view !== null) view.cancelAnimationFrame(frame);
    frame = 0;
  }

  return {
    answers(callback) {
      sink = callback;
    },
    origin() {
      const rect = ensureLayer().getBoundingClientRect();
      colorScheme = hostColorScheme(doc);
      return { top: rect.top, left: rect.left };
    },
    show(el, key, rect, origin) {
      const current = prompts.get(el);
      if (current?.key === key) return;
      if (current) remove(current.host);
      const host = build(key);
      const at = place(rect, origin);
      host.style.cssText =
        `position:absolute;left:${at.left}px;top:${at.top}px;` +
        `width:max-content;max-width:${at.maxWidth}px;pointer-events:auto;margin:0;color-scheme:${colorScheme}`;
      ensureLayer().append(host);
      prompts.set(el, { host, key, at });
      watch();
    },
    revalidate,
    hide(el) {
      const current = prompts.get(el);
      if (!current) return;
      prompts.delete(el);
      current.host.remove();
      if (prompts.size === 0) stopWatching();
    },
    clear() {
      for (const { host } of prompts.values()) host.remove();
      prompts.clear();
      stopWatching();
      layer?.remove();
      layer = undefined;
    }
  };
}
