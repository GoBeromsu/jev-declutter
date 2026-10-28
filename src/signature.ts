import type { ItemDescriptor, SiteId } from "./types";

export function fnv1a(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function token(el: Element, here: string): string {
  let t = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  if (role) t += `[r=${role}]`;
  const testId = el.getAttribute("data-testid");
  if (testId) t += `[t=${testId.replace(/\d+/g, "#")}]`;
  if (el.hasAttribute("aria-label")) t += "[a]";
  if (el.tagName === "A") {
    const href = el.getAttribute("href");
    if (href !== null && href.startsWith("http")) {
      let linkHost: string;
      try {
        linkHost = new URL(href).host;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        linkHost = here;
      }
      if (linkHost !== here) t += "[ext]";
    }
  }
  if (el.tagName === "VIDEO") t += "[v]";
  if (el.tagName === "IMG") t += "[i]";
  return t;
}

/**
 * Structural key of an item: breadth-first tokens to `depth`, at most `maxNodes`
 * elements, FNV-1a 32-bit hex. Text, classes, ids and attribute values (other than
 * role/data-testid) never enter it, so a recycled or re-labelled cell keeps its key.
 */
export function signature(el: Element, site: SiteId, depth = 4, maxNodes = 64): string {
  const here = typeof location === "undefined" ? "" : location.host;
  const levels: string[][] = [];
  let level: Element[] = [el];
  let count = 0;
  for (let d = 0; d < depth && level.length > 0 && count < maxNodes; d++) {
    const tokens: string[] = [];
    const next: Element[] = [];
    for (const node of level) {
      if (count >= maxNodes) break;
      count++;
      tokens.push(token(node, here));
      for (const child of Array.from(node.children)) next.push(child);
    }
    levels.push(tokens);
    level = next;
  }
  return `${site}:${fnv1a(levels.map((tokens) => tokens.join(",")).join(">"))}`;
}

/**
 * Cache key: the skeleton plus the UI-chrome signals. Sponsored and organic cards can
 * share an identical skeleton and differ only in label text, so a verdict is never
 * cached by bare skeleton; signalKey still collapses the many items that share labels.
 */
export function signalKey(
  signature: string,
  d: Pick<
    ItemDescriptor,
    "chrome_text" | "has_follow_button" | "has_external_link" | "ad_attribute" | "media" | "path_kind"
  >
): string {
  const signals = JSON.stringify([
    d.chrome_text,
    d.has_follow_button,
    d.has_external_link,
    d.ad_attribute,
    d.media,
    d.path_kind
  ]);
  return fnv1a(`${signature}|${signals}`);
}
