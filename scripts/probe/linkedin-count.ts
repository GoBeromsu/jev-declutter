// Drift-probe counting logic. Pure: one DOM root + one SiteConfig in, seven numbers out.
//
// Why it exists (plan todo 22, F4 shortfall S2 / risk b): LinkedIn's React ad detection rests on
// the single label slot `h2 + div p[componentkey]`, whose three assumptions (the attribute, the
// adjacency, the `div` tag) each take detection from all to none - silently, and fail-open, so
// nothing on the page or in the logs would ever say so. React *suggested* detection rests on a
// `Suggested`/`추천` label that has never been observed live. This module is the detector: it
// compares the shipped config's verdicts against an INDEPENDENT ground truth and reports only how
// many items fell on each side.
//
// Privacy: the return value is seven numbers. No text, name, URL or identifier is returned,
// stored or logged here, and no caller can obtain one from it.

import { AD_WORDS, SUGGESTED_WORDS, matchesWord } from "../../src/markers";
import { deterministic } from "../../src/rules";
import { extractSignals } from "../../src/signals";
import type { SiteConfig } from "../../src/sites";

/** Counts only. Every field is a non-negative integer. */
export interface DriftCounts {
  /** Items matched by `cfg.item` under the probed root. */
  itemsSeen: number;
  /** Items the ground truth below finds an exact AD_WORDS marker on. */
  adMarkerItems: number;
  /** Of those, how many the shipped config decides as `ad`. A shortfall here is a slot regression. */
  adDetected: number;
  /** Items the ground truth finds an exact SUGGESTED_WORDS marker on (0 live so far - that zero is the point). */
  suggestedMarkerItems: number;
  /** Of those, how many the shipped config decides as `suggested`. */
  suggestedDetected: number;
  /** Items with NEITHER marker that the shipped config still decides - a false mark, the one failure IS-2 forbids. */
  organicFalseMarked: number;
  /** Longest chromeText string over all items: the privacy canary (a body-text leak shows up as a long string). */
  maxChromeLen: number;
}

/**
 * No marker word is longer than this (pinned by the "marker word length guard" test in
 * tests/signals.test.ts), and `slotText` truncates there anyway, so a longer text node is prose,
 * never a label.
 */
export const MARKER_MAX_CHARS = 40;

export interface HeaderMarkers {
  ad: boolean;
  suggested: boolean;
}

/**
 * GROUND-TRUTH RULE - deliberately independent of `cfg.labelSlots`.
 *
 * The probe exists to catch a label-slot regression, so it must not ask the label slots where the
 * markers are: if it did, removing a slot would remove the marker and the ground truth with it,
 * the two counts would stay equal, and the probe could never report a miss (proven by the
 * failing-control test in tests/probe.test.ts, which strips the React slots and still finds every
 * marker here).
 *
 * The rule, using only structure the config cannot influence except through `bodyExclude`:
 *
 *   Walk the item in document order and read SHORT TEXT NODES (<= 40 collapsed chars) until the
 *   first `bodyExclude` container is reached; a text node whose collapsed text EXACTLY equals an
 *   AD_WORDS / SUGGESTED_WORDS entry (trim + whitespace collapse + case fold, via the shipped
 *   `matchesWord`) marks the item.
 *
 * Three independent reasons that region is the right one, and each is a guard against counting
 * user-authored text as a marker:
 *  - It stops at the first `bodyExclude` match, so the post's own commentary - the one place a
 *    member can type "Promoted" or "추천" and manufacture a ground truth - is never read. The
 *    React fixtures' `adSentence` and `bodyNeg` items are exactly that attack and are pinned.
 *  - Every marker LinkedIn ships sits above the body: the legacy actor sub-description, the React
 *    actor sub-description and the React update header are all before the commentary paragraph.
 *    Verified on both React fixtures, and live on 2026-10-29 in the sense that matters: every ad
 *    marker the shipped slots detected was also found here (7/7, 7/7, 4/4 over three sessions) and
 *    no item was marked without one. Text below the body is the social action bar ("Like",
 *    reaction counts), which carries no marker word.
 *  - The 40-char cut keeps a sentence that merely contains a marker word out; only a standalone
 *    label can match.
 *
 * `bodyExclude` is the single config field the rule depends on, which is sound: it is a Must-NOT
 * of the plan that `bodyExclude` ever shrink, and the probe needs *some* notion of "where the
 * user's own words start".
 *
 * Known gaps, both of which surface as a FALSE MARK rather than as silence - the probe still says
 * "not ok", just in the wrong column, which is the property that matters here:
 *  - a marker moved BELOW the body container is not read, so a detected ad would be counted as a
 *    markerless item that the config marked;
 *  - a marker split across sibling text nodes (`Prom` + `oted`) matches neither node, while the
 *    shipped `slotText` concatenates and would still detect it. Every marker observed live or in
 *    the fixtures is a single text node.
 *
 * And one limitation to read the numbers with: this ground truth is LABEL-based, so an item the
 * config marks from STRUCTURE alone - a `cfg.adSelectors` attribute, or a follow button under
 * `followMeansSuggested` - carries no marker word and lands in `organicFalseMarked`. That is why
 * the legacy LinkedIn fixtures report 3 (2 structural ads + 1 follow-only item, pinned in
 * tests/probe.test.ts) while the React pair reports 0: on the React feed `adSelectors` and
 * `followSlot` match nothing at all, which is precisely the condition that makes
 * `organicFalseMarked` readable as "organic posts we wrongly marked".
 */
export function headerMarkers(item: Element, cfg: SiteConfig): HeaderMarkers {
  let ad = false;
  let suggested = false;
  // Pre-order walk with an explicit stack: children pushed in reverse so each pop is the next node
  // in document order. Iterative, so a deeply nested React card cannot overflow the stack.
  const stack: Node[] = [item];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      const text = (node as CharacterData).data.replace(/\s+/g, " ").trim();
      if (text === "" || text.length > MARKER_MAX_CHARS) continue;
      if (matchesWord(text, AD_WORDS)) ad = true;
      else if (matchesWord(text, SUGGESTED_WORDS)) suggested = true;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    // The user's own content starts here: the header region is over.
    if (el !== item && cfg.bodyExclude !== "" && el.matches(cfg.bodyExclude)) break;
    const kids = el.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return { ad, suggested };
}

/**
 * Counts the shipped config's agreement with the ground truth over every item under `root`.
 *
 * Buckets are exclusive and follow `deterministic`'s own precedence (ad beats suggested), so the
 * three item counts always sum to `itemsSeen`: an item is an ad-marker item, a suggested-marker
 * item, or a markerless item that is only ever counted when it is wrongly marked.
 */
export function countDrift(root: ParentNode, cfg: SiteConfig): DriftCounts {
  const counts: DriftCounts = {
    itemsSeen: 0,
    adMarkerItems: 0,
    adDetected: 0,
    suggestedMarkerItems: 0,
    suggestedDetected: 0,
    organicFalseMarked: 0,
    maxChromeLen: 0
  };
  for (const item of root.querySelectorAll(cfg.item)) {
    counts.itemsSeen++;
    const truth = headerMarkers(item, cfg);
    const signals = extractSignals(item, cfg);
    for (const chrome of signals.chromeText) {
      if (chrome.length > counts.maxChromeLen) counts.maxChromeLen = chrome.length;
    }
    const verdict = deterministic(signals, cfg);
    if (truth.ad) {
      counts.adMarkerItems++;
      if (verdict?.category === "ad") counts.adDetected++;
    } else if (truth.suggested) {
      counts.suggestedMarkerItems++;
      if (verdict?.category === "suggested") counts.suggestedDetected++;
    } else if (verdict !== null) {
      counts.organicFalseMarked++;
    }
  }
  return counts;
}
