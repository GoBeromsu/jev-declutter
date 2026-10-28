import type { DecisionProvider } from "../types";
import { ProviderError, RUBRIC, questionsFor, toWireItem } from "./common";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

interface NoulQuestion {
  type: "noul";
  instructions: string;
}

interface SystemOneAnswer {
  type?: unknown;
  noul?: unknown;
}

interface SystemOneResponse {
  model?: unknown;
  answers?: Record<string, SystemOneAnswer | null | undefined>;
}

export const DEFAULT_TYPESAFE_MODEL = "jev-latest";

export const typesafeProvider: DecisionProvider = {
  id: "typesafe",
  async classify(site, items, key, model, fetchImpl = fetch) {
    const questions: Record<string, NoulQuestion> = {};
    for (const q of questionsFor(items.length)) questions[q.name] = { type: "noul", instructions: q.instructions };

    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: { rubric: RUBRIC, site, items: items.map(toWireItem) }, questions })
    });
    if (!res.ok) throw new ProviderError(res.status, await res.text());

    const body = await readJson(res);
    return {
      model: typeof body.model === "string" ? body.model : model,
      scores: items.map((_, n) => ({
        ad: noul(body, `i${n}_ad`),
        suggested: noul(body, `i${n}_suggested`)
      }))
    };
  }
};

async function readJson(res: Response): Promise<SystemOneResponse> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as SystemOneResponse) : {};
  } catch {
    return {};
  }
}

function noul(body: SystemOneResponse, name: string): number | null {
  const answer = body.answers?.[name];
  if (!answer || typeof answer !== "object" || answer.type !== "noul") return null;
  const value = answer.noul;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
