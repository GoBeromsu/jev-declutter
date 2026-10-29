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
  /**
   * Label slots whose text LINK_WRAPPER withheld. Internal to the scanner, never sent: a withheld
   * slot must not be read as absent chrome, or the "no signals at all -> keep without asking"
   * branch in src/scan.ts stops asking the model about a card whose only chrome is a name
   * (todo 27 gate finding F1: 13 of 19 Instagram items per fixture, including the one the fixture
   * requires to be blurred or hidden). `toDescriptor` lists the wire fields explicitly.
   */
  withheldSlots: number;
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
 * Nested link subtrees are skipped when reading a slot: a marker word is the site's own label and
 * is never a link, while link text inside a chrome slot names an entity, and README promises
 * author names are never sent. LinkedIn's React actor paragraph wraps the member's
 * `a[href*="/in/"]`: 12 of 30 and 10 of 31 live slots in two sessions carried one, and its text
 * reached chrome_text verbatim in every single case, up to 37 chars (todo 22 finding F1 and its
 * gate review). No fallback when the rule empties a slot - 3 of 31 live slots were nothing but
 * anchor text, so falling back to the raw text would re-leak exactly those; an empty slot is
 * simply dropped. Nested only: a slot that IS an anchor is still read, so a site that labels an
 * ad with a linked "Promoted" keeps its marker. 0 of 7 live markers sat inside an anchor, and if
 * one ever does, the LinkedIn drift probe reports adDetected < adMarkerItems.
 * The companion case - the slot itself being a link's DESCENDANT - is handled by LINK_WRAPPER
 * below, which also covers the href-less `<a>` and `[role="link"]` wrappers this selector misses.
 */
const LINK_SUBTREE = "a[href]";

/**
 * Link-ish wrappers ABOVE a label slot. A slot inside one of these is reading link text, which
 * names an entity: live X puts every eligible label slot inside a profile-shaped link (3 of 3
 * eligible slots over three read-only sessions, single-segment href, no `<time>`, no digit, the
 * link carrying no text of its own) and read up to 27 chars of it into chrome_text, which goes to
 * the model on a cache miss - the leak todo 22 fixed for LinkedIn, on X
 * (.omo/evidence/aside-feed-declutter-todo-26-gate-review.md, finding F3).
 * Such a slot therefore contributes ONLY an exact marker word (see extractSignals), never its free
 * text, so the strings it can still emit are the fixed constants of src/markers.ts and never an
 * identifier. Keeping the marker is not an empirical claim about today's markup: `matchesWord` is
 * exact equality, so a slot whose text is not a marker sets no flag in the first place - dropping
 * its string cannot change any verdict, on any site, now or after a markup change. That is why the
 * rule needs no per-site qualifier and no profile-href heuristic.
 * `a` and not `a[href]`: live X's wrapper is both an `<a>` and a `[role="link"]`, and an href-less
 * `<a>` carries text just the same (todo 26 gate finding F2).
 * `insideWithin` tests the item root itself before stopping, so an item root that IS a link counts
 * as a wrapper and withholds every non-marker slot in that item. No shipped `cfg.item` can match
 * one (0 of 710 fixture items), and the direction is the safe one: markers still survive (above),
 * so the worst case is a structure-only descriptor, which src/scan.ts still sends to the model.
 */
const LINK_WRAPPER = 'a, [role="link"]';

/**
 * Own text of a slot: text nodes only, skipping any nested subtree that matches bodyExclude or
 * LINK_SUBTREE, so a slot that wraps post text or a profile link cannot carry it out. Iterative:
 * nesting depth cannot overflow the stack.
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
    if (node !== slot && node.nodeType === 1) {
      const el = node as Element;
      if (bodyExclude !== "" && el.matches(bodyExclude)) continue;
      if (el.matches(LINK_SUBTREE)) continue;
    }
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
  let withheldSlots = 0;
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
    // Flags are computed first and are never affected: only the string is withheld.
    const parent = slot.parentElement;
    if (!isAd && !isSuggested && parent !== null && insideWithin(parent, LINK_WRAPPER, el)) {
      withheldSlots++;
      continue;
    }
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

  return { adAttribute, adLabel, suggestedLabel, followButton, chromeText, withheldSlots, hasExternalLink, media };
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
