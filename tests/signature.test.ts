import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { fnv1a, signalKey, signature } from "../src/signature";
import type { ItemDescriptor } from "../src/types";

const el = (html: string): Element => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as Element;
};

const navigateTo = (url: string): void => {
  (globalThis as unknown as { location: Location }).location = new Window({ url }).location as unknown as Location;
};

const article = (tweet: string, cls = ""): Element =>
  el(`<article class="${cls}" role="article">
    <div class="a"><div class="b"><div class="c">${tweet}</div></div></div>
    <img src="x.png" class="media">
  </article>`);

const signals = (over: Partial<ItemDescriptor> = {}) => ({
  chrome_text: [] as string[],
  has_follow_button: false,
  has_external_link: false,
  ad_attribute: false,
  media: "none" as const,
  path_kind: "feed",
  ...over
});

test("fnv1a matches the FNV-1a 32-bit reference vectors", () => {
  expect(fnv1a("")).toBe("811c9dc5");
  expect(fnv1a("a")).toBe("e40c292c");
});

test("same skeleton with different text and class names is equal", () => {
  const a = signature(article("Buy our product now, 50% off!", "ad-card promo"), "x");
  const b = signature(article("A friend posted a photo of their dog", "organic-1"), "x");
  expect(a).toBe(b);
  expect(a.startsWith("x:")).toBe(true);
  expect(a.split(":")[1]).toMatch(/^[0-9a-f]{8}$/);
});

test("only text content changes: the signature never moves (no text is read)", () => {
  const node = article("first text");
  const before = signature(node, "instagram");
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) walker.currentNode.textContent = "completely different words 123";
  expect(node.textContent).toContain("completely different words");
  expect(signature(node, "instagram")).toBe(before);
});

test("an extra placementTracking wrapper changes the signature", () => {
  const plain = signature(article("hello"), "x");
  const wrapped = signature(
    el(`<div role="article"><div data-testid="placementTracking"><div class="a"><div class="b"><div class="c">hello</div></div></div><img src="x.png" class="media"></div></div>`),
    "x"
  );
  const wrappedInCell = signature(
    el(`<article role="article"><div data-testid="placementTracking"><div class="a"><div class="b"><div class="c">hello</div></div></div><img src="x.png" class="media"></div></article>`),
    "x"
  );
  expect(wrapped).not.toBe(plain);
  expect(wrappedInCell).not.toBe(plain);
});

test("data-testid digit runs are normalized", () => {
  const one = el(`<div><div data-testid="cell-123"></div></div>`);
  const two = el(`<div><div data-testid="cell-987"></div></div>`);
  const three = el(`<div><div data-testid="cell-4"></div></div>`);
  expect(signature(one, "x")).toBe(signature(two, "x"));
  expect(signature(one, "x")).toBe(signature(three, "x"));
  expect(signature(one, "x")).not.toBe(signature(el(`<div><div data-testid="other-123"></div></div>`), "x"));
});

test("role, aria-label presence, external link, video and img are tokens", () => {
  const withRole = el(`<div role="article"></div>`);
  expect(signature(withRole, "x")).not.toBe(signature(el(`<div></div>`), "x"));
  expect(signature(el(`<div aria-label="A"></div>`), "x")).toBe(signature(el(`<div aria-label="B"></div>`), "x"));
  expect(signature(el(`<div aria-label="A"></div>`), "x")).not.toBe(signature(el(`<div></div>`), "x"));
  expect(signature(el(`<div><a href="https://example.com/x">hi</a></div>`), "x")).not.toBe(
    signature(el(`<div><a href="/inbox">hi</a></div>`), "x")
  );
  expect(signature(el(`<div><a href="https://x.com/u/a"></a></div>`), "x")).toBe(
    signature(el(`<div><a href="https://example.com/x"></a></div>`), "x")
  );
});

test("[ext] uses the raw href attribute: protocol-relative and relative links are never external", () => {
  navigateTo("https://x.com/home");
  const onPage = (href: string): string => {
    const div = document.createElement("div");
    div.innerHTML = `<a href="${href}"></a>`;
    return signature(div.firstElementChild as Element, "x");
  };
  const same = onPage("/inbox");
  expect(onPage("//elsewhere.example/ad")).toBe(same);
  expect(onPage("https://x.com/ad")).toBe(same);
  expect(onPage("https://elsewhere.example/ad")).not.toBe(same);
  expect(onPage("http://elsewhere.example/ad")).not.toBe(same);
  expect(onPage("")).toBe(same);
});

test("signature() reads location.host: a navigated page tells same-host from cross-host absolute links", () => {
  navigateTo("https://x.com/home");
  expect(location.host).toBe("x.com");
  const hashOf = (href: string): string => {
    const div = document.createElement("div");
    div.innerHTML = `<div><a href="${href}"></a></div>`;
    return signature(div.firstElementChild as Element, "x");
  };
  const sameHost = hashOf("https://x.com/home");
  expect(sameHost).toBe(`x:${fnv1a("div>a")}`);
  expect(hashOf("//elsewhere.example/ad")).toBe(sameHost);
  expect(hashOf("/inbox")).toBe(sameHost);
  expect(hashOf("https://elsewhere.example/ad")).toBe(`x:${fnv1a("div>a[ext]")}`);
  expect(hashOf("https://x.com/home")).not.toBe(hashOf("https://elsewhere.example/ad"));
});

test("an unparsable href gets no [ext] and does not throw", () => {
  navigateTo("https://x.com/home");
  for (const href of ["httpfoo", "http://", "https://", "http://[::1", "http:"]) {
    const div = document.createElement("div");
    div.innerHTML = `<div><a href="${href}" aria-label="x"></a></div>`;
    expect(signature(div.firstElementChild as Element, "x")).toBe(`x:${fnv1a("div>a[a]")}`);
  }
});

test("class names and ids never enter the signature", () => {
  const a = el(`<div class="one" id="a"><span class="x"></span></div>`);
  const b = el(`<div class="two other" id="zzz"><span class="y" style="color:red"></span></div>`);
  expect(signature(a, "linkedin")).toBe(signature(b, "linkedin"));
});

test("more than maxNodes elements truncate deterministically", () => {
  const make = (tag: string) => {
    const root = document.createElement("div");
    for (let i = 0; i < 1000; i++) {
      const child = document.createElement(tag);
      root.appendChild(child);
    }
    return root;
  };
  const first = signature(make("span"), "youtube");
  const second = signature(make("span"), "youtube");
  expect(first).toBe(second);
  const root = document.createElement("div");
  for (let i = 0; i < 63; i++) root.appendChild(document.createElement("span"));
  const before = signature(root, "youtube");
  root.appendChild(document.createElement("video"));
  expect(signature(root, "youtube")).toBe(before);
  root.insertBefore(document.createElement("video"), root.children[5] ?? null);
  expect(signature(root, "youtube")).not.toBe(before);
});

test("depth limits the walk: deeper structure below the limit is ignored", () => {
  const shallow = el(`<div><div></div></div>`);
  const deep = el(`<div><div><div><div><div><video></video></div></div></div></div></div>`);
  expect(signature(shallow, "x", 2)).toBe(signature(deep, "x", 2));
  expect(signature(shallow, "x", 6)).not.toBe(signature(deep, "x", 6));
});

test("an element with only text nodes returns a stable non-empty signature", () => {
  const node = el(`<div>just some words</div>`);
  const a = signature(node, "instagram");
  expect(a).toContain("instagram:");
  expect(a.split(":")[1]).toHaveLength(8);
  node.textContent = "other words";
  expect(signature(node, "instagram")).toBe(a);
});

test("empty elements and detached elements do not throw", () => {
  expect(signature(document.createElement("div"), "x")).toMatch(/^x:[0-9a-f]{8}$/);
  expect(signature(el(`<div></div>`), "linkedin")).toMatch(/^linkedin:[0-9a-f]{8}$/);
  expect(() => signature(el(`<div><!-- comment --></div>`), "x")).not.toThrow();
});

test("a 500-level tree is bounded and does not throw", () => {
  let node = document.createElement("div");
  const root = node;
  for (let i = 0; i < 500; i++) {
    const child = document.createElement("div");
    node.appendChild(child);
    node = child;
  }
  const a = signature(root, "x");
  expect(a).toMatch(/^x:[0-9a-f]{8}$/);
  expect(signature(root, "x")).toBe(a);
});

test("site is part of the signature", () => {
  const node = el(`<div><span></span></div>`);
  expect(signature(node, "x")).not.toBe(signature(node, "youtube"));
});

test("signalKey differs with different chrome_text and is equal with the same signals", () => {
  const sig = signature(article("hello"), "instagram");
  const base = signals();
  const sponsored = signals({ chrome_text: ["Sponsored"] });
  const suggested = signals({ chrome_text: ["Suggested for you"] });
  expect(signalKey(sig, sponsored)).not.toBe(signalKey(sig, base));
  expect(signalKey(sig, sponsored)).not.toBe(signalKey(sig, suggested));
  expect(signalKey(sig, sponsored)).toBe(signalKey(sig, { ...sponsored, chrome_text: ["Sponsored"] }));
  const otherSig = signature(article("hello again"), "instagram");
  expect(otherSig).toBe(sig);
});

test("signalKey embeds the skeleton signature and the ordered JSON array", () => {
  const sig = "x:deadbeef";
  const d = signals({ chrome_text: ["광고"], has_follow_button: true, media: "image" });
  const json = JSON.stringify([d.chrome_text, d.has_follow_button, d.has_external_link, d.ad_attribute, d.media, d.path_kind]);
  expect(signalKey(sig, d)).toBe(fnv1a(`${sig}|${json}`));
  expect(signalKey("x:00000000", d)).not.toBe(signalKey(sig, d));
});

test("signalKey reacts to every signal field", () => {
  const sig = "x:12345678";
  const base = signals();
  const keys = new Set([
    signalKey(sig, base),
    signalKey(sig, signals({ has_follow_button: true })),
    signalKey(sig, signals({ has_external_link: true })),
    signalKey(sig, signals({ ad_attribute: true })),
    signalKey(sig, signals({ media: "video" })),
    signalKey(sig, signals({ path_kind: "search" }))
  ]);
  expect(keys.size).toBe(6);
});
