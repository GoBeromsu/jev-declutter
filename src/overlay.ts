import type { OverrideDecision } from "./overrides";

/** Viewport rect of the item the prompt belongs to, read in the scanner's geometry phase. */
export interface OverlayRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Viewport position of the positioning layer, so a prompt is placed by subtraction alone. */
export interface OverlayOrigin {
  top: number;
  left: number;
}

/** Where a prompt was placed, in layer-relative (document) coordinates. */
interface Placement {
  left: number;
  top: number;
  maxWidth: number;
}

export interface OverlayHost {
  /** Registers the sink for a user answer; the scanner owns what happens next. */
  answers(callback: (key: string, decision: OverrideDecision) => void): void;
  origin(): OverlayOrigin;
  show(el: Element, key: string, rect: OverlayRect, origin: OverlayOrigin): void;
  hide(el: Element): void;
  /**
   * Drops every prompt whose item has moved, resized or left the page. Returns immediately while
   * no prompt is up, so the scanner can call it at the end of each flush for free.
   */
  revalidate(): void;
  clear(): void;
}

export const OVERLAY_LAYER_ID = "jev-declutter-layer";

const INSET = 8;

const TEXT = {
  ko: { question: "광고 맞아요?", yes: "예", no: "아니오", label: "이 항목이 광고인지 알려주기" },
  en: { question: "Is this an ad?", yes: "Yes", no: "No", label: "Tell the extension whether this item is an ad" }
} as const;

/** Page lang first (the feed's own language), then the browser UI language, then English. */
export function promptLanguage(doc: Document, uiLanguage: string): "ko" | "en" {
  const page = doc.documentElement.getAttribute("lang") ?? "";
  const tag = page.trim() !== "" ? page : uiLanguage;
  return tag.trim().toLowerCase().startsWith("ko") ? "ko" : "en";
}

/**
 * Styles live in this shadow root only: the page's rules cannot reach in (`all:initial` resets
 * what inheritance would carry across the host) and these rules cannot reach the page, so the
 * shared item stylesheet (src/decide.ts ITEM_CSS) stays the only thing we put in the document.
 */
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

/**
 * Events the prompt swallows, so a click on it can never become a click on the feed item, a
 * navigation or a site hotkey. The prompt is NOT a descendant of the item (the item is blurred,
 * and `filter` would blur the prompt with it), so bubbling is stopped at the host.
 *
 * Bubble-phase delegation - what feed sites use - sees nothing. CAPTURE-phase listeners on
 * document or window still observe the event and cannot be stopped from inside without an iframe;
 * they see a retargeted `event.target` of the overlay host, which has no feed ancestor, so a site
 * cannot mistake it for a click on one of its own items. Nothing is sent and nothing navigates.
 */
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

/**
 * One prompt per model-blurred item, rendered in a shadow root inside a single out-of-flow layer.
 *
 * Zero layout shift, by construction:
 *  - the feed item is never touched: no position, no style, no extra child, so neither its box nor
 *    the containing block of its children changes;
 *  - the layer is `position:absolute` and 0x0 at the document origin, so adding it adds nothing to
 *    any flow, and a prompt inside it is placed in document coordinates: it scrolls with the page
 *    like the item it covers, so scrolling alone never needs it re-placed;
 *  - a prompt is placed once and NEVER moved - moving it is the only thing here that could
 *    register a shift. A prompt whose item moved, resized, left the page or changed verdict is
 *    removed instead (removal moves nothing), and a new one is placed in the next flush.
 */
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
        // Answer only for what the prompt is still sitting on. If the page moved or dropped that
        // item without any event we watch, the click is dropped with the prompt rather than
        // persisting a permanent verdict for a skeleton the user never judged.
        const live = anchored(host);
        // The prompt is answered: drop it now, so the feedback is immediate even if the
        // scanner's own re-evaluation of that key lands a frame later.
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

  /** Layer-relative placement: the layer sits at the document origin, so this is scroll-invariant. */
  function place(rect: OverlayRect, origin: OverlayOrigin): Placement {
    const inset = Math.min(INSET, rect.width / 4, rect.height / 4);
    return {
      left: rect.left - origin.left + inset,
      top: rect.top - origin.top + inset,
      maxWidth: Math.max(0, rect.width - inset * 2)
    };
  }

  /** True when the item is gone, or no longer where the prompt was placed over it. */
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

  /** Checked at the moment a prompt is answered - the one moment where being wrong is permanent. */
  function anchored(host: HTMLElement): boolean {
    const entry = [...prompts].find(([, prompt]) => prompt.host === host);
    if (!entry) return false;
    return !drifted(entry[0], entry[1].at, layerOrigin());
  }

  /**
   * A prompt is placed once and never moved - moving it is the one thing that could register a
   * layout shift - so a prompt whose item moved is REMOVED instead. The frame loop below runs
   * this while a prompt is up; the scanner also calls it at the end of each flush, so a verdict
   * applied in that flush is never left placed from geometry the same flush changed.
   * Costs one comparison while no prompt is up.
   */
  function revalidate() {
    if (prompts.size === 0) return;
    const origin = layerOrigin();
    for (const [el, prompt] of [...prompts]) if (drifted(el, prompt.at, origin)) remove(prompt.host);
  }

  /**
   * While a prompt is up, ask once a frame whether its item is still underneath it.
   *
   * One mechanism for every cause, because the page announces almost none of them: a scroll, a
   * window resize, a virtualized cell re-positioned by a transform, content inserted above the
   * item, an image finishing its load, the item being detached. Measured on the first attempt at
   * this fix: scroll and resize listeners plus a hook at the end of the scanner's flush still left
   * the pill standing over ANOTHER post after an insertion above it and after the item was
   * detached, because neither mutation produces a scanner flush at all (QA scenarios
   * overlay-stranded-insert / -detach, which failed exactly there).
   *
   * Costs one rect read per prompt per frame, and only while a prompt is on screen - the scanner
   * already runs a frame loop for the whole page lifetime.
   */
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
      // Never move a prompt that is already up: a move is the one thing that could shift layout.
      if (current?.key === key) return;
      if (current) remove(current.host);
      const host = build(key);
      const at = place(rect, origin);
      // `width:max-content` because the layer is 0x0: shrink-to-fit would otherwise size the
      // prompt against a zero-width containing block and wrap every word.
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
