import { DAILY_REQUEST_BUDGET, loadSigCache, providerKey } from "./cache";
import { today } from "./decide";
import { DEFAULT_TYPESAFE_MODEL } from "./providers/typesafe";
import { DEFAULT_SETTINGS, budgetKey, loadSettings } from "./storage";
import type { Action, Category, Message, ProviderId, Settings, SiteId } from "./types";

export const SITE_IDS: readonly SiteId[] = ["youtube", "x", "instagram", "linkedin"];
const CATEGORIES: readonly Category[] = ["ad", "suggested", "module"];
const ACTIONS: readonly Action[] = ["hide", "blur", "keep"];
const PROVIDERS: readonly ProviderId[] = ["openai", "typesafe"];

const SITE_LABELS: Record<SiteId, string> = { youtube: "YouTube", x: "X", instagram: "Instagram", linkedin: "LinkedIn" };

const DEFAULT_MODEL: Record<ProviderId, string> = {
  openai: DEFAULT_SETTINGS.openai.model,
  typesafe: DEFAULT_TYPESAFE_MODEL
};

export interface DiagnosticsView {
  day: string;
  currentKey: string;
  caches: Partial<Record<SiteId, unknown>>;
  budgetUsed: number;
}

type Row = [key: string, ad: string, suggested: string];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const oneOf = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

function $<T extends Element>(root: ParentNode, id: string): T {
  const el = root.querySelector<T>(`#${id}`);
  if (!el) throw new Error(`options page: #${id} is missing from options.html`);
  return el;
}

const input = (root: ParentNode, id: string) => $<HTMLInputElement>(root, id);
const select = (root: ParentNode, id: string) => $<HTMLSelectElement>(root, id);
const radios = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLInputElement>('input[name="provider"]'));

const modelOf = (raw: string, provider: ProviderId): string => raw.trim() || DEFAULT_MODEL[provider];

function providerOf(root: ParentNode): ProviderId {
  const checked = radios(root).find((r) => r.checked);
  return checked ? oneOf(checked.value, PROVIDERS, DEFAULT_SETTINGS.provider) : DEFAULT_SETTINGS.provider;
}

export function collectForm(root: ParentNode = document): Settings {
  const sites = {} as Settings["sites"];
  for (const site of SITE_IDS) sites[site] = { enabled: input(root, `site-${site}`).checked };
  const actions = {} as Settings["actions"];
  for (const category of CATEGORIES) {
    actions[category] = oneOf(select(root, `action-${category}`).value, ACTIONS, DEFAULT_SETTINGS.actions[category]);
  }
  return {
    provider: providerOf(root),
    openai: { apiKey: input(root, "openai-key").value.trim(), model: modelOf(input(root, "openai-model").value, "openai") },
    typesafe: { apiKey: input(root, "typesafe-key").value.trim(), model: modelOf(input(root, "typesafe-model").value, "typesafe") },
    sites,
    actions
  };
}

export function populateForm(settings: Settings, root: ParentNode = document): void {
  for (const r of radios(root)) r.checked = r.value === settings.provider;
  input(root, "openai-key").value = settings.openai.apiKey;
  input(root, "openai-model").value = settings.openai.model;
  input(root, "typesafe-key").value = settings.typesafe.apiKey;
  input(root, "typesafe-model").value = settings.typesafe.model;
  for (const site of SITE_IDS) input(root, `site-${site}`).checked = settings.sites[site].enabled;
  for (const category of CATEGORIES) select(root, `action-${category}`).value = settings.actions[category];
}

const score = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "-");

function rowsOf(entries: Record<string, unknown>, order: unknown): Row[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(order)) {
    for (const k of order) {
      if (typeof k === "string" && !seen.has(k) && Object.hasOwn(entries, k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  for (const k of Object.keys(entries)) if (!seen.has(k)) keys.push(k);
  return keys.map((k) => {
    const v = entries[k];
    return [k, score(isRecord(v) ? v.ad : undefined), score(isRecord(v) ? v.suggested : undefined)];
  });
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function tableOf(doc: Document, rows: Row[]): HTMLTableElement {
  const table = el(doc, "table");
  const head = el(doc, "thead");
  const headRow = el(doc, "tr");
  headRow.append(el(doc, "th", "key", "signalKey"), el(doc, "th", "num", "광고"), el(doc, "th", "num", "추천"));
  head.append(headRow);
  const body = el(doc, "tbody");
  for (const [key, ad, suggested] of rows) {
    const tr = el(doc, "tr");
    tr.append(el(doc, "td", "key", key), el(doc, "td", "num", ad), el(doc, "td", "num", suggested));
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

function siteBlock(doc: Document, site: SiteId, view: DiagnosticsView): HTMLElement {
  const raw = view.caches[site];
  const cache = isRecord(raw) ? raw : undefined;
  const entries = cache && isRecord(cache.entries) ? cache.entries : {};
  const rows = cache ? rowsOf(entries, cache.order) : [];
  const day = cache && typeof cache.day === "string" ? cache.day : "";
  const key = cache && typeof cache.providerKey === "string" ? cache.providerKey : "";
  const stale = cache !== undefined && (day !== view.day || key !== view.currentKey);

  const block = el(doc, "section", "diag");
  block.id = `diag-${site}`;
  block.dataset.day = day;
  block.dataset.providerKey = key;
  block.dataset.rows = String(rows.length);
  block.dataset.stale = String(stale);

  const head = el(doc, "div", "diag-head");
  head.append(el(doc, "h3", "", SITE_LABELS[site]));
  if (!cache) head.append(el(doc, "span", "tag tag-none", "캐시 없음"));
  else if (stale) head.append(el(doc, "span", "tag tag-stale", "현재 설정과 다름"));
  else head.append(el(doc, "span", "tag tag-fresh", "오늘"));
  block.append(head);

  if (!cache) {
    block.append(el(doc, "p", "empty", "아직 이 사이트의 판정이 저장되지 않았습니다."));
    return block;
  }
  block.append(el(doc, "p", "meta", `day ${day || "?"} · providerKey ${key || "?"} · ${rows.length}개`));
  block.append(rows.length === 0 ? el(doc, "p", "empty", "저장된 판정이 없습니다.") : tableOf(doc, rows));
  return block;
}

export function renderDiagnostics(view: DiagnosticsView, root: ParentNode = document): void {
  const doc = root.ownerDocument ?? (root as Document);
  const used = Number.isFinite(view.budgetUsed) && view.budgetUsed >= 0 ? view.budgetUsed : 0;

  const budget = $<HTMLElement>(root, "budget");
  budget.dataset.used = String(used);
  budget.dataset.limit = String(DAILY_REQUEST_BUDGET);
  const usage = el(doc, "span", "", "오늘 모델 요청 ");
  usage.append(el(doc, "strong", "", `${used} / ${DAILY_REQUEST_BUDGET}`));
  const current = el(doc, "span", "", "현재 providerKey ");
  current.append(el(doc, "code", "", view.currentKey));
  budget.replaceChildren(usage, el(doc, "span", "", "·"), current);

  $<HTMLElement>(root, "diagnostics").replaceChildren(...SITE_IDS.map((site) => siteBlock(doc, site, view)));
}

export async function loadDiagnostics(settings: Settings): Promise<DiagnosticsView> {
  const day = today();
  const caches: Partial<Record<SiteId, unknown>> = {};
  const loaded = await Promise.all(SITE_IDS.map((site) => loadSigCache(site)));
  SITE_IDS.forEach((site, i) => {
    caches[site] = loaded[i];
  });
  const key = budgetKey(day);
  const budget = (await chrome.storage.local.get(key))[key] as unknown;
  const count = isRecord(budget) ? budget.count : undefined;
  return {
    day,
    currentKey: providerKey(settings),
    caches,
    budgetUsed: typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : 0
  };
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function main(root: ParentNode = document): Promise<void> {
  const form = $<HTMLFormElement>(root, "settings");
  const status = $<HTMLElement>(root, "status");
  const note = (state: "saved" | "reset" | "error", message: string) => {
    status.textContent = message;
    status.dataset.state = state;
  };
  const refresh = async () => renderDiagnostics(await loadDiagnostics(await loadSettings()), root);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      try {
        const settings = collectForm(root);
        await chrome.storage.local.set({ settings });
        populateForm(settings, root);
        await refresh();
        note("saved", "저장했습니다. 다음 페이지 이동부터 적용됩니다.");
      } catch (err) {
        note("error", `저장 실패: ${describe(err)}`);
      }
    })();
  });

  $<HTMLButtonElement>(root, "reset").addEventListener("click", () => {
    void (async () => {
      try {
        const msg: Message = { type: "reset" };
        await chrome.runtime.sendMessage(msg);
        await refresh();
        note("reset", "오늘 캐시를 비웠습니다. 다음 페이지 이동부터 다시 판정합니다.");
      } catch (err) {
        note("error", `캐시 비우기 실패: ${describe(err)}`);
      }
    })();
  });

  populateForm(await loadSettings(), root);
  await refresh();
}

if (typeof document !== "undefined" && document.querySelector("#settings")) {
  main().catch((err: unknown) => {
    console.error("[jev-declutter] options page failed to load", err);
    const status = document.querySelector<HTMLElement>("#status");
    if (status) {
      status.textContent = `설정을 불러오지 못했습니다: ${describe(err)}`;
      status.dataset.state = "error";
    }
  });
}
