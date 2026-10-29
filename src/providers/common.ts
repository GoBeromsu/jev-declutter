import type { ItemDescriptor } from "../types";

export const QUESTION_VERSION = 1;

export const RUBRIC =
  "Each element of `items` is one entry of a social feed. You receive only its structure and UI labels: " +
  "no post text, no author names, no image pixels. Decide two predicates per item." +
  "`ad`: the item is a paid advertisement, or a sponsored or promoted placement." +
  "`suggested`: the platform recommends the item from an account or channel the user does not follow " +
  "(for example 'Suggested for you', a follow button offered, or a recommendation slot), " +
  "rather than showing it from one the user follows." +
  "Judge from the structural fields only; when the evidence is weak, answer with a low probability.";

/** A provider score is trusted only as a finite probability in [0, 1]; anything else is missing (null = keep). */
export function asProbability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export interface Question {
  name: string;
  instructions: string;
}

export function questionsFor(count: number): Question[] {
  const out: Question[] = [];
  for (let n = 0; n < count; n += 1) {
    out.push({
      name: `i${n}_ad`,
      instructions: `Is \`items[${n}]\` a paid advertisement or a sponsored/promoted placement?`
    });
    out.push({
      name: `i${n}_suggested`,
      instructions:
        `Is \`items[${n}]\` recommended by the platform from an account or channel the user does not follow, ` +
        "rather than from one the user follows?"
    });
  }
  return out;
}

export function toWireItem(d: ItemDescriptor): ItemDescriptor {
  return {
    n: d.n,
    key: d.key,
    signature: d.signature,
    chrome_text: [...d.chrome_text],
    has_follow_button: d.has_follow_button,
    has_external_link: d.has_external_link,
    ad_attribute: d.ad_attribute,
    media: d.media,
    path_kind: d.path_kind
  };
}

export class ProviderError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(`provider rejected the request (${status}): ${detail}`);
    this.name = "ProviderError";
    this.status = status;
  }
}
