import type { DecisionProvider, ProviderId } from "../types";
import { openaiProvider } from "./openai";
import { typesafeProvider } from "./typesafe";

const PROVIDERS: Record<ProviderId, DecisionProvider> = {
  openai: openaiProvider,
  typesafe: typesafeProvider
};

export function providerFor(id: ProviderId): DecisionProvider {
  if (!Object.hasOwn(PROVIDERS, id)) throw new Error(`unsupported provider: ${String(id)}`);
  return PROVIDERS[id];
}
