import { AD_WORDS, FOLLOW_WORDS, SUGGESTED_WORDS, matchesWord } from "./markers";
import { signalKey, signature } from "./signature";
import type { SiteConfig } from "./sites";
import type { ItemDescriptor } from "./types";

export interface Signals {
  adAttribute: boolean;
  adLabel: boolean;
  suggestedLabel: boolean;
  followButton: boolean;
  chromeText: string[];
  hasExternalLink: boolean;
  media: "video" | "image" | "none";
}

const MAX_CHROME = 8;
const MAX_CHARS = 40;

/** True when `node` or an ancestor up to and including `root` matches `selector`; never looks past `root`. */
function insideWithin(node: Element, selector: string, root: Element): boolean {
  if (selector === "") return false;
  for (let cur: Element | null = node; cur !== null; cur = cur.parentElement) {
    if (cur.matches(selector)) return true;
    if (cur === root) return false;
  }
  return false;
}

/**
 * Own text of a slot: text nodes only, skipping any nested subtree that matches bodyExclude,
 * so a slot that wraps post text cannot carry it out. Iterative: nesting depth cannot overflow the stack.
 * Stops reading once the collapsed text is longer than MAX_CHARS: no marker word is that long and
 * the stored string is cut there anyway, so a slot with thousands of text nodes costs a handful of reads.
 */
function slotText(slot: Element, bodyExclude: string): string {
  let out = "";
  const stack: Node[] = [slot];
  while (stack.length > 0 && out.trim().length <= MAX_CHARS) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      out = (out + (node as CharacterData).data).replace(/\s+/g, " ");
      continue;
    }
    if (node !== slot && bodyExclude !== "" && node.nodeType === 1 && (node as Element).matches(bodyExclude)) continue;
    const kids = node.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out.trim();
}

function isExternal(href: string): boolean {
  if (!/^https?:/i.test(href)) return false;
  try {
    return new URL(href).host !== location.host;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export function extractSignals(el: Element, cfg: SiteConfig): Signals {
  const adAttribute = cfg.adSelectors.some((s) => el.matches(s) || el.querySelector(s) !== null);

  let adLabel = false;
  let suggestedLabel = false;
  const markers: { at: number; text: string }[] = [];
  const ordinary: { at: number; text: string }[] = [];
  let at = 0;
  for (const slot of el.querySelectorAll(cfg.labelSlots)) {
    if (insideWithin(slot, cfg.bodyExclude, el)) continue;
    const text = slotText(slot, cfg.bodyExclude);
    if (text === "") continue;
    const isAd = matchesWord(text, AD_WORDS);
    const isSuggested = matchesWord(text, SUGGESTED_WORDS);
    adLabel ||= isAd;
    suggestedLabel ||= isSuggested;
    const bucket = isAd || isSuggested ? markers : ordinary;
    if (bucket.length < MAX_CHROME) bucket.push({ at: at++, text: text.slice(0, MAX_CHARS) });
    else at++;
  }
  const kept = [...markers, ...ordinary.slice(0, MAX_CHROME - markers.length)];
  const chromeText = kept.sort((x, y) => x.at - y.at).map((k) => k.text);

  let followButton = false;
  if (cfg.followSlot !== "") {
    for (const f of el.querySelectorAll(cfg.followSlot)) {
      if (insideWithin(f, cfg.bodyExclude, el)) continue;
      if (matchesWord(slotText(f, cfg.bodyExclude), FOLLOW_WORDS)) {
        followButton = true;
        break;
      }
    }
  }

  let hasExternalLink = false;
  for (const a of el.querySelectorAll("a[href]")) {
    if (isExternal(a.getAttribute("href") ?? "")) {
      hasExternalLink = true;
      break;
    }
  }

  const media = el.querySelector("video") !== null ? "video" : el.querySelector("img") !== null ? "image" : "none";

  return { adAttribute, adLabel, suggestedLabel, followButton, chromeText, hasExternalLink, media };
}

/** path_kind is a coarse feed-route index ("feed<i>" or "other"), never a raw path, so usernames, ids and queries cannot leak. */
function pathKind(cfg: SiteConfig): string {
  const path = typeof location === "undefined" ? "" : location.pathname;
  const i = cfg.feedPaths.findIndex((re) => re.test(path));
  return i >= 0 ? `feed${i}` : "other";
}

export function toDescriptor(n: number, el: Element, cfg: SiteConfig, sig: Signals): ItemDescriptor {
  const parts = {
    chrome_text: sig.chromeText,
    has_follow_button: sig.followButton,
    has_external_link: sig.hasExternalLink,
    ad_attribute: sig.adAttribute,
    media: sig.media,
    path_kind: pathKind(cfg)
  };
  const skeleton = signature(el, cfg.id);
  return { n, key: signalKey(skeleton, parts), signature: skeleton, ...parts };
}
