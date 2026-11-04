import { AD_WORDS, SUGGESTED_WORDS, matchesWord } from "../../src/markers";
import { deterministic } from "../../src/rules";
import { extractSignals } from "../../src/signals";
import type { SiteConfig } from "../../src/sites";

export interface DriftCounts {
  itemsSeen: number;
  adMarkerItems: number;
  adDetected: number;
  suggestedMarkerItems: number;
  suggestedDetected: number;
  organicFalseMarked: number;
  maxChromeLen: number;
}

export const MARKER_MAX_CHARS = 40;

export interface HeaderMarkers {
  ad: boolean;
  suggested: boolean;
}

export function headerMarkers(item: Element, cfg: SiteConfig): HeaderMarkers {
  let ad = false;
  let suggested = false;
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
    if (el !== item && cfg.bodyExclude !== "" && el.matches(cfg.bodyExclude)) break;
    const kids = el.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return { ad, suggested };
}

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
