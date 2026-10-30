import { afterEach, expect, test } from "bun:test";
import { createOverlay, OVERLAY_LAYER_ID, promptLanguage } from "../src/overlay";
import type { OverrideDecision } from "../src/overrides";

const built: { clear(): void }[] = [];

afterEach(() => {
  // Stops the frame loop of any prompt a test left standing.
  for (const overlay of built.splice(0)) overlay.clear();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("lang");
});

const RECT = { top: 120, left: 40, width: 600, height: 300 };
const ORIGIN = { top: 0, left: 0 };

function fixture(lang = "en", ui = "en-US") {
  document.documentElement.setAttribute("lang", lang);
  const item = document.createElement("div");
  item.className = "feed-item";
  item.textContent = "a post body that must never be copied";
  document.body.append(item);
  // happy-dom has no layout: give the item the geometry the prompt is placed from, so the
  // overlay's own anchor check sees what a browser would.
  anchored(item, RECT);
  const answers: { key: string; decision: OverrideDecision }[] = [];
  const overlay = createOverlay((key, decision) => answers.push({ key, decision }), document, ui);
  built.push(overlay);
  return { item, answers, overlay };
}

const hosts = () => Array.from(document.querySelectorAll<HTMLElement>("[data-jev-overlay]"));
const button = (host: HTMLElement, answer: "yes" | "no") => {
  const el = host.shadowRoot?.querySelector<HTMLButtonElement>(`[data-answer="${answer}"]`);
  if (!el) throw new Error(`the prompt has no ${answer} button`);
  return el;
};

test("promptLanguage prefers the page lang and falls back to the browser UI language", () => {
  const doc = (lang: string | null) => {
    const d = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
    if (lang !== null) d.documentElement.setAttribute("lang", lang);
    return d;
  };
  expect(promptLanguage(doc("ko"), "en-US")).toBe("ko");
  expect(promptLanguage(doc("ko-KR"), "en-US")).toBe("ko");
  expect(promptLanguage(doc("en"), "ko-KR")).toBe("en");
  expect(promptLanguage(doc(""), "ko-KR")).toBe("ko");
  expect(promptLanguage(doc(null), "ko")).toBe("ko");
  expect(promptLanguage(doc(null), "")).toBe("en");
  expect(promptLanguage(doc("  KO-kr "), "")).toBe("ko");
});

for (const [lang, question, yes, no] of [
  ["ko", "광고 맞아요?", "예", "아니오"],
  ["en", "Is this an ad?", "Yes", "No"]
] as const) {
  test(`the ${lang} prompt renders in a shadow root over the item without touching it`, () => {
    // Given
    const { item, overlay } = fixture(lang);
    const before = item.outerHTML;
    // When
    overlay.show(item, "1fd217c7", RECT, overlay.origin());
    // Then: one host, outside the item, inside the non-flow layer.
    const host = hosts()[0];
    expect(hosts()).toHaveLength(1);
    expect(host).toBeDefined();
    expect(item.contains(host as Node)).toBe(false);
    expect(item.outerHTML).toBe(before);
    expect(item.getAttribute("style")).toBeNull();
    const layer = document.getElementById(OVERLAY_LAYER_ID);
    expect(host?.parentElement).toBe(layer);
    expect(layer?.style.position).toBe("absolute");
    expect(layer?.style.width).toBe("0px");
    expect(layer?.style.height).toBe("0px");
    // And: positioned over the item, with the prompt itself in the shadow root only.
    expect(host?.style.position).toBe("absolute");
    expect(parseFloat(host?.style.left ?? "")).toBeGreaterThanOrEqual(RECT.left);
    expect(parseFloat(host?.style.top ?? "")).toBeGreaterThanOrEqual(RECT.top);
    expect(parseFloat(host?.style.left ?? "")).toBeLessThan(RECT.left + RECT.width);
    expect(host?.getAttribute("data-jev-key")).toBe("1fd217c7");
    expect(host?.textContent).toBe("");
    const shadow = host?.shadowRoot;
    expect(shadow).toBeTruthy();
    expect(shadow?.textContent).toContain(question);
    expect(button(host as HTMLElement, "yes").textContent).toBe(yes);
    expect(button(host as HTMLElement, "no").textContent).toBe(no);
    expect(shadow?.textContent).not.toContain("post body");
    // And: the shared item stylesheet is not what styles it - the styles live in the shadow root.
    expect(shadow?.querySelector("style")?.textContent ?? "").toContain("all:initial");
    expect(document.querySelectorAll("style").length).toBe(0);
  });
}

for (const answer of ["no", "yes"] as const) {
  test(`answering ${answer} reports the decision, drops the prompt and never reaches the page`, () => {
    // Given: a page listener that must not see the click, and no navigation.
    const { item, answers, overlay } = fixture("en");
    overlay.show(item, "key-1", RECT, overlay.origin());
    const seen: string[] = [];
    const listener = (event: Event) => seen.push(event.type);
    for (const type of ["click", "mousedown", "pointerdown", "keydown"]) {
      document.addEventListener(type, listener);
    }
    const href = location.href;
    // When
    const host = hosts()[0] as HTMLElement;
    const target = button(host, answer);
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
    // Then
    expect(answers).toEqual([{ key: "key-1", decision: answer === "no" ? "keep" : "confirmed" }]);
    expect(hosts()).toHaveLength(0);
    expect(seen).toEqual([]);
    expect(location.href).toBe(href);
    for (const type of ["click", "mousedown", "pointerdown", "keydown"]) {
      document.removeEventListener(type, listener);
    }
  });
}

test("show never moves an existing prompt and a new key replaces it", () => {
  const { item, overlay } = fixture("en");
  overlay.show(item, "key-1", RECT, ORIGIN);
  const first = hosts()[0] as HTMLElement;
  const left = first.style.left;
  const top = first.style.top;

  overlay.show(item, "key-1", { ...RECT, top: 900, left: 900 }, ORIGIN);
  expect(hosts()[0]).toBe(first);
  expect(first.style.left).toBe(left);
  expect(first.style.top).toBe(top);

  overlay.show(item, "key-2", { ...RECT, top: 900, left: 900 }, ORIGIN);
  const second = hosts()[0] as HTMLElement;
  expect(hosts()).toHaveLength(1);
  expect(second).not.toBe(first);
  expect(second.getAttribute("data-jev-key")).toBe("key-2");
  expect(second.style.top).not.toBe(top);
});

test("a narrow item clamps the prompt inside its own box", () => {
  const { item, overlay } = fixture("en");
  overlay.show(item, "k", { top: 10, left: 10, width: 12, height: 8 }, ORIGIN);
  const host = hosts()[0] as HTMLElement;
  expect(parseFloat(host.style.maxWidth)).toBeGreaterThan(0);
  expect(parseFloat(host.style.maxWidth)).toBeLessThanOrEqual(12);
  expect(parseFloat(host.style.left)).toBeGreaterThanOrEqual(10);
  expect(parseFloat(host.style.left)).toBeLessThan(22);
});

test("hide removes one prompt and clear removes every prompt and the layer", () => {
  const { item, overlay } = fixture("en");
  const second = document.createElement("div");
  document.body.append(second);
  overlay.show(item, "k1", RECT, ORIGIN);
  overlay.show(second, "k2", RECT, ORIGIN);
  expect(hosts()).toHaveLength(2);

  overlay.hide(item);
  expect(hosts()).toHaveLength(1);
  overlay.hide(item);
  expect(hosts()).toHaveLength(1);

  overlay.clear();
  expect(hosts()).toHaveLength(0);
  expect(document.getElementById(OVERLAY_LAYER_ID)).toBeNull();

  // And: the layer comes back for the next prompt.
  overlay.show(item, "k3", RECT, overlay.origin());
  expect(hosts()).toHaveLength(1);
  expect(document.getElementById(OVERLAY_LAYER_ID)).not.toBeNull();
});

test("a prompt whose item moved under it is removed, never moved", async () => {
  // Given: a prompt over an item at a fixed place.
  const { item, overlay } = fixture("en");
  let rect = { top: 100, left: 0, width: 400, height: 200, bottom: 300, right: 400 };
  Object.defineProperty(item, "getBoundingClientRect", { configurable: true, value: () => rect });
  overlay.show(item, "k", rect, overlay.origin());
  const host = hosts()[0] as HTMLElement;
  const placed = { left: host.style.left, top: host.style.top };

  // When: the page scrolls and the item has not moved relative to the document.
  window.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(hosts()).toHaveLength(1);
  expect({ left: host.style.left, top: host.style.top }).toEqual(placed);

  // When: a virtualized feed moves the cell out from under the prompt.
  rect = { ...rect, top: 4000, bottom: 4200 };
  window.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  // Then: the prompt is gone rather than repositioned.
  expect(hosts()).toHaveLength(0);
});

test("a prompt whose item left the page is removed on the next frame", async () => {
  const { item, overlay } = fixture("en");
  overlay.show(item, "k", RECT, overlay.origin());
  item.remove();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(hosts()).toHaveLength(0);
});

// --- attempt 2: every re-layout, not only a scroll ---------------------------------------------

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function anchored(item: HTMLElement, rect: { top: number; left: number; width: number; height: number }) {
  Object.defineProperty(item, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...rect, bottom: rect.top + rect.height, right: rect.left + rect.width, x: rect.left, y: rect.top })
  });
}

test("an unannounced re-layout removes the prompt within a frame, with no scroll and no event", async () => {
  // Given: a prompt over an item, and a page that moves it without telling anyone - content
  // inserted above it, an image finishing its load, a virtualized cell re-positioned.
  const { item, overlay } = fixture("en");
  const rect = { top: 100, left: 0, width: 400, height: 200 };
  anchored(item, rect);
  overlay.show(item, "k", rect, overlay.origin());
  // When
  anchored(item, { ...rect, top: 300 });
  await nextFrame();
  // Then
  expect(hosts()).toHaveLength(0);
});

test("a resize that moves the item removes the prompt, with no scroll", async () => {
  // Given: a prompt placed over an item.
  const { item, overlay } = fixture("en");
  const rect = { top: 100, left: 180, width: 640, height: 300 };
  anchored(item, rect);
  overlay.show(item, "k", rect, overlay.origin());
  expect(hosts()).toHaveLength(1);

  // When: the viewport changes and the item's column moves, as a window resize does.
  anchored(item, { ...rect, left: 300, width: 400 });
  window.dispatchEvent(new Event("resize"));
  await nextFrame();

  // Then: the prompt is gone rather than left floating beside the card.
  expect(hosts()).toHaveLength(0);
});

test("revalidate drops a prompt whose item moved or left the page, with no scroll and no resize", async () => {
  const { item, overlay } = fixture("en");
  const rect = { top: 100, left: 0, width: 400, height: 200 };
  anchored(item, rect);
  overlay.show(item, "k", rect, overlay.origin());

  // Content inserted above the item pushes it down; nothing scrolls and nothing resizes.
  anchored(item, { ...rect, top: 300 });
  overlay.revalidate();
  expect(hosts()).toHaveLength(0);

  // The same for an item the page detached.
  const second = document.createElement("div");
  document.body.append(second);
  anchored(second, rect);
  overlay.show(second, "k2", rect, overlay.origin());
  expect(hosts()).toHaveLength(1);
  second.remove();
  overlay.revalidate();
  expect(hosts()).toHaveLength(0);
});

test("revalidate keeps a prompt whose item has not moved and costs nothing when none is up", () => {
  const { item, overlay } = fixture("en");
  const rect = { top: 100, left: 0, width: 400, height: 200 };
  anchored(item, rect);
  overlay.revalidate();
  overlay.show(item, "k", rect, overlay.origin());
  overlay.revalidate();
  overlay.revalidate();
  expect(hosts()).toHaveLength(1);
});

for (const how of ["moved", "detached"] as const) {
  test(`a click on a prompt whose item was ${how} is dropped instead of persisting an answer`, () => {
    // Given: a prompt that the page stranded without any event the overlay listens to.
    const { item, answers, overlay } = fixture("en");
    const rect = { top: 100, left: 0, width: 400, height: 200 };
    anchored(item, rect);
    overlay.show(item, "k", rect, overlay.origin());
    const host = hosts()[0] as HTMLElement;
    if (how === "moved") anchored(item, { ...rect, top: 900 });
    else item.remove();

    // When: the user clicks what is now sitting over something else.
    button(host, "no").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));

    // Then: nothing is persisted for a skeleton the user never judged, and the pill is gone.
    expect(answers).toEqual([]);
    expect(hosts()).toHaveLength(0);
  });
}
