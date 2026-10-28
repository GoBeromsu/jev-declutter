import type { DecisionProvider, ItemScores } from "../types";
import { ProviderError, RUBRIC, questionsFor, toWireItem } from "./common";

const ENDPOINT = "https://api.openai.com/v1/decisions";

function probabilityOf(answer: unknown): number | null {
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as { type?: unknown; probability?: unknown };
  if (a.type !== "predicate") return null;
  const p = a.probability;
  return typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

export const openaiProvider: DecisionProvider = {
  id: "openai",
  async classify(site, items, key, model, fetchImpl = fetch) {
    const body = {
      model,
      input: [
        { role: "developer", content: [{ type: "input_text", text: RUBRIC }] },
        { role: "user", content: [{ type: "input_json", data: { site, items: items.map(toWireItem) } }] }
      ],
      questions: questionsFor(items.length).map((q) => ({ type: "predicate", name: q.name, instructions: q.instructions })),
      prompt_cache_key: `jev-declutter:${site}`
    };
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new ProviderError(response.status, text);

    let parsed: { model?: unknown; answers?: unknown } = {};
    try {
      const json: unknown = JSON.parse(text);
      if (typeof json === "object" && json !== null) parsed = json;
    } catch {
      parsed = {};
    }

    const byName = new Map<string, unknown>();
    if (Array.isArray(parsed.answers)) {
      for (const answer of parsed.answers) {
        const name = (answer as { name?: unknown } | null)?.name;
        if (typeof name === "string") byName.set(name, byName.has(name) ? null : answer);
      }
    }
    const scores: ItemScores[] = items.map((_, n) => ({
      ad: probabilityOf(byName.get(`i${n}_ad`)),
      suggested: probabilityOf(byName.get(`i${n}_suggested`))
    }));
    return { model: typeof parsed.model === "string" ? parsed.model : model, scores };
  }
};
