export type SiteId = "youtube" | "x" | "instagram";

export type Action = "keep" | "blur" | "hide";

/** A page component Jev is asked about. `selector` is what the CSS will target. */
export interface Candidate {
  selector: string;
  description: string;
  /** Short visible text from the page, when the component is present. */
  sample?: string;
  source: "seed" | "discovered";
}

export interface Decision {
  selector: string;
  description: string;
  action: Action;
  distracting: number;
  essential: number;
}

/** One day's frozen result for one site. The CSS never changes until `day` rolls over. */
export interface SiteCache {
  day: string;
  site: SiteId;
  model: string;
  decisions: Decision[];
  css: string;
}

export interface Settings {
  apiKey: string;
  model: string;
  goals: Record<SiteId, string>;
}

export type Message =
  | { type: "snapshot"; site: SiteId; candidates: Candidate[] }
  | { type: "reset" };

export type RefreshResult =
  | { ok: true; status: "fresh" | "refreshed"; cache: SiteCache }
  | { ok: false; error: string };
