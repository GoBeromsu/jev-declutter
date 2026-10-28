export type SiteId = "youtube" | "x" | "instagram" | "linkedin";

export type Action = "keep" | "blur" | "hide";

export type Category = "ad" | "suggested" | "module";

export type ProviderId = "openai" | "typesafe";

export interface Settings {
  provider: ProviderId;
  openai: { apiKey: string; model: string };
  typesafe: { apiKey: string; model: string };
  sites: Record<SiteId, { enabled: boolean }>;
  actions: Record<Category, Action>;
}

/** Structure and UI-chrome labels only: no post text ever enters this shape. */
export interface ItemDescriptor {
  n: number;
  key: string;
  signature: string;
  chrome_text: string[];
  has_follow_button: boolean;
  has_external_link: boolean;
  ad_attribute: boolean;
  media: "video" | "image" | "none";
  path_kind: string;
}

/** null = refused or missing answer: keep that item. */
export interface ItemScores {
  ad: number | null;
  suggested: number | null;
}

export interface DecisionProvider {
  id: ProviderId;
  classify(
    site: SiteId,
    items: ItemDescriptor[],
    key: string,
    model: string,
    fetchImpl?: typeof fetch
  ): Promise<{ model: string; scores: ItemScores[] }>;
}

export type Message = { type: "classify"; site: SiteId; items: ItemDescriptor[] } | { type: "reset" };

export type ClassifyResult = { ok: true; scores: ItemScores[] } | { ok: false; error: string };

export type SignatureVerdict = { ad: number | null; suggested: number | null };

export interface SignatureCache {
  day: string;
  providerKey: string;
  entries: Record<string, SignatureVerdict>;
}
