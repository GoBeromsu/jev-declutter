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

const CSS =
  ".box{all:initial;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;" +
  "padding:3px 6px;border-radius:999px;background:rgba(17,17,17,.9);color:#fff;" +
  "font:500 12px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.35)}" +
  ".q{all:initial;color:#fff;font:500 12px/1.4 system-ui,-apple-system,sans-serif;white-space:nowrap;" +
  "overflow:hidden;text-overflow:ellipsis}" +
  "button{all:initial;cursor:pointer;padding:1px 8px;border-radius:999px;background:#fff;color:#111;" +
  "font:600 12px/1.4 system-ui,-apple-system,sans-serif}" +
  "button:hover{background:#dcdcdc}" +
  "button:focus-visible{outline:2px solid #4c9ffe;outline-offset:1px}";

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
        remove(host);
        if (live) sink(key, decision);
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
        `width:max-content;max-width:${at.maxWidth}px;pointer-events:auto;margin:0`;
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
