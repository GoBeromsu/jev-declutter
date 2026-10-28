export const QUESTION_VERSION = 1;

export const RUBRIC =
  "Each element of `items` is one entry of a social feed. You receive only its structure and UI labels: " +
  "no post text, no author names, no image pixels. Decide two predicates per item." +
  "`ad`: the item is a paid advertisement, or a sponsored or promoted placement." +
  "`suggested`: the platform recommends the item from an account or channel the user does not follow " +
  "(for example 'Suggested for you', a follow button offered, or a recommendation slot), " +
  "rather than showing it from one the user follows." +
  "Judge from the structural fields only; when the evidence is weak, answer with a low probability.";

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

export class ProviderError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(`provider rejected the request (${status}): ${detail}`);
    this.name = "ProviderError";
    this.status = status;
  }
}
