import type { Candidate } from "./types";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

interface NoulQuestion {
  type: "noul";
  instructions: string;
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}

interface SystemOneResponse {
  model: string;
  answers: Record<string, NoulAnswer | { type: string }>;
}

export class JevError extends Error {}

/**
 * One request per site: the state holds the goal and every candidate, and each candidate gets
 * two atomic Noul questions that point at it by path (`components[i]`).
 */
export function buildQuestions(count: number): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  for (let i = 0; i < count; i++) {
    questions[`c${i}_distracting`] = {
      type: "noul",
      instructions: `Is \`components[${i}]\` an attention-capturing element (algorithmic recommendations, trends, short-form video, engagement bait, or upsells) that does not serve \`user_goal\`?`
    };
    questions[`c${i}_essential`] = {
      type: "noul",
      instructions: `Is \`components[${i}]\` needed to accomplish \`user_goal\` or to use the site's core functions (search, the feed of followed accounts, messages, settings, or the content currently being viewed)?`
    };
  }
  return questions;
}

export interface Scores {
  distracting: number;
  essential: number;
}

export async function askJev(
  apiKey: string,
  model: string,
  site: string,
  goal: string,
  candidates: Candidate[]
): Promise<{ model: string; scores: Scores[] }> {
  const state = {
    site,
    user_goal: goal,
    components: candidates.map((c) => ({ description: c.description, selector: c.selector, visible_text: c.sample ?? "" }))
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, state, questions: buildQuestions(candidates.length) })
  });
  if (!res.ok) throw new JevError(`Jev HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as SystemOneResponse;
  return { model: body.model, scores: candidates.map((_, i) => ({
    distracting: noul(body, `c${i}_distracting`),
    essential: noul(body, `c${i}_essential`)
  })) };
}

function noul(body: SystemOneResponse, id: string): number {
  const answer = body.answers[id];
  if (!answer || answer.type !== "noul" || typeof (answer as NoulAnswer).noul !== "number") {
    throw new JevError(`Jev response is missing noul answer ${id}`);
  }
  return (answer as NoulAnswer).noul;
}
