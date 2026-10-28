import { describe, expect, test } from "bun:test";
import { providerFor } from "../src/providers";
import type { ItemDescriptor, ProviderId } from "../src/types";

const BODY_SENTINEL = "PRIVATE-BODY-SENTINEL-4f2a-not-for-the-wire";
const DECLARED = [
  "ad_attribute",
  "chrome_text",
  "has_external_link",
  "has_follow_button",
  "key",
  "media",
  "n",
  "path_kind",
  "signature"
];

function baseItem(): ItemDescriptor {
  return {
    n: 0,
    key: "k0",
    signature: "sig0",
    chrome_text: ["Sponsored"],
    has_follow_button: false,
    has_external_link: false,
    ad_attribute: false,
    media: "image",
    path_kind: "feed"
  };
}

function probeItem(): ItemDescriptor {
  const proto = { prototypeLeak: `prototype ${BODY_SENTINEL}` };
  const item: ItemDescriptor = Object.assign(Object.create(proto) as ItemDescriptor, baseItem());
  Object.defineProperty(item, "__proto__", {
    value: { ownProtoLeak: `own __proto__ ${BODY_SENTINEL}` },
    enumerable: true,
    configurable: true,
    writable: true
  });
  return Object.assign(item, {
    post_body: `post body text ${BODY_SENTINEL}`,
    author_bio: `author bio ${BODY_SENTINEL}`,
    comments: [`comment one ${BODY_SENTINEL}`, `comment two ${BODY_SENTINEL}`],
    image_pixels: [`data:image/png;base64,${BODY_SENTINEL}`],
    bodyText: `camelCase body text ${BODY_SENTINEL}`,
    nested: { deep: { text: `nested object ${BODY_SENTINEL}` } },
    largeUndeclared: `${BODY_SENTINEL}`.repeat(20000)
  });
}

interface Captured {
  url: string;
  body: string;
}

function capture(providerId: ProviderId): { fetchImpl: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: String(init?.body ?? "") });
    return Response.json({ model: "m", answers: [] });
  }) as unknown as typeof fetch;
  void providerId;
  return { fetchImpl, captured };
}

const PROVIDERS: ProviderId[] = ["openai", "typesafe"];

describe("privacy boundary: no undeclared field reaches either provider", () => {
  for (const id of PROVIDERS) {
    test(`${id}: undeclared and inherited item fields never serialize`, async () => {
      const provider = providerFor(id);
      const { fetchImpl, captured } = capture(id);
      const item = probeItem();
      expect(JSON.stringify(item)).toContain(BODY_SENTINEL);

      await provider.classify("x", [item], "privacy-key", "m", fetchImpl);

      expect(captured.length).toBe(1);
      const body = captured[0]!.body;
      expect(body.includes(BODY_SENTINEL)).toBe(false);
      for (const leak of ["post_body", "author_bio", "comments", "image_pixels", "bodyText", "__proto__", "prototypeLeak", "nested", "largeUndeclared"]) {
        expect(body).not.toContain(leak);
      }
    });

    test(`${id}: the wire item carries exactly the declared fields`, async () => {
      const provider = providerFor(id);
      const { fetchImpl, captured } = capture(id);
      const item = probeItem();

      await provider.classify("x", [item], "privacy-key", "m", fetchImpl);

      const parsed = JSON.parse(captured[0]!.body) as Record<string, any>;
      const wireItem =
        id === "openai" ? parsed.input[1].content[0].data.items[0] : parsed.state.items[0];
      expect(Object.keys(wireItem).sort()).toEqual(DECLARED);
      expect(Object.getOwnPropertyNames(wireItem).sort()).toEqual(DECLARED);
      expect(Object.hasOwn(wireItem, "__proto__")).toBe(false);
      expect(Object.getPrototypeOf(wireItem)).toBe(Object.prototype);
      expect(wireItem.chrome_text).toEqual(["Sponsored"]);
      expect(wireItem).not.toBe(item);
      expect(wireItem.chrome_text).not.toBe(item.chrome_text);
    });
  }

  test("the shared filter returns a fresh object with a fresh chrome_text array", async () => {
    const { toWireItem } = await import("../src/providers/common");
    const item = Object.assign(baseItem(), { post_body: BODY_SENTINEL });
    const wire = toWireItem(item);
    expect(wire).not.toBe(item);
    expect(wire.chrome_text).not.toBe(item.chrome_text);
    expect(Object.keys(wire).sort()).toEqual(DECLARED);
    expect(JSON.stringify(wire)).not.toContain(BODY_SENTINEL);
    wire.chrome_text.push("mutated");
    expect(item.chrome_text).toEqual(["Sponsored"]);
  });
});
