import { DAILY_REQUEST_BUDGET, loadOverCap, loadSigCache, providerKey } from "./cache";
import { actionFor, actionsOf, combine, today } from "./decide";
import { clearOverride, clearOverrides, loadOverrides, type OverrideDecision, type OverrideMap } from "./overrides";
import { DEFAULT_TYPESAFE_MODEL } from "./providers/typesafe";
import { DEFAULT_SETTINGS, budgetKey, loadSettings } from "./storage";
import type { Message, ProviderId, Settings, SiteId } from "./types";

export const SITE_IDS: readonly SiteId[] = ["youtube", "x", "instagram", "linkedin"];
const PROVIDERS: readonly ProviderId[] = ["openai", "typesafe"];

const SITE_LABELS: Record<SiteId, string> = { youtube: "YouTube", x: "X", instagram: "Instagram", linkedin: "LinkedIn" };
const PROVIDER_LABELS: Record<ProviderId, string> = { openai: "OpenAI", typesafe: "Jev" };

const PAUSE_STORAGE_KEY = "pauseUntil";
const BUDGET_WARNING_RATIO = 0.8;
const SAVED_CHIP_MS = 2400;
const KEY_TYPING_DEBOUNCE_MS = 350;

const DEFAULT_MODEL: Record<ProviderId, string> = {
  openai: DEFAULT_SETTINGS.openai.model,
  typesafe: DEFAULT_TYPESAFE_MODEL
};

export interface DiagnosticsView {
  day: string;
  currentKey: string;
  caches: Partial<Record<SiteId, unknown>>;
  budgetUsed: number;
  overCap?: Partial<Record<SiteId, readonly string[]>>;
  overrides?: Partial<Record<SiteId, OverrideMap>>;
  settings?: Settings;
  pausedUntil?: number;
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
const modelSelect = (root: ParentNode) => $<HTMLSelectElement>(root, "model");

function parseModel(value: string): { provider: ProviderId; model: string } {
  const at = value.indexOf(":");
  const provider = oneOf(at < 0 ? "" : value.slice(0, at), PROVIDERS, DEFAULT_SETTINGS.provider);
  const model = at < 0 ? "" : value.slice(at + 1).trim();
  return { provider, model: model || DEFAULT_MODEL[provider] };
}

function ensureOption(select: HTMLSelectElement, provider: ProviderId, model: string): void {
  const value = `${provider}:${model}`;
  if (Array.from(select.options).some((o) => o.value === value)) return;
  const option = (select.ownerDocument ?? document).createElement("option");
  option.value = value;
  option.textContent = `${PROVIDER_LABELS[provider]} · ${model}`;
  select.append(option);
}

export function collectForm(root: ParentNode = document): Settings {
  const sites = {} as Settings["sites"];
  for (const site of SITE_IDS) sites[site] = { enabled: input(root, `site-${site}`).checked };
  const select = modelSelect(root);
  const chosen = parseModel(select.value);
  const modelOf = (p: ProviderId) => (p === chosen.provider ? chosen.model : select.dataset[p] || DEFAULT_MODEL[p]);
  return {
    provider: chosen.provider,
    openai: { apiKey: input(root, "openai-key").value.trim(), model: modelOf("openai") },
    typesafe: { apiKey: input(root, "typesafe-key").value.trim(), model: modelOf("typesafe") },
    sites,
    hideAds: input(root, "hide-ads").checked,
    hideSuggested: input(root, "hide-suggested").checked
  };
}

export function populateForm(settings: Settings, root: ParentNode = document): void {
  const select = modelSelect(root);
  for (const p of PROVIDERS) {
    ensureOption(select, p, settings[p].model);
    select.dataset[p] = settings[p].model;
  }
  select.value = `${settings.provider}:${settings[settings.provider].model}`;
  input(root, "openai-key").value = settings.openai.apiKey;
  input(root, "typesafe-key").value = settings.typesafe.apiKey;
  for (const site of SITE_IDS) input(root, `site-${site}`).checked = settings.sites[site].enabled;
  input(root, "hide-ads").checked = settings.hideAds;
  input(root, "hide-suggested").checked = settings.hideSuggested;
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

function tableOf(doc: Document, rows: Row[], overCap: ReadonlySet<string>): HTMLTableElement {
  const table = el(doc, "table");
  const head = el(doc, "thead");
  const headRow = el(doc, "tr");
  headRow.append(el(doc, "th", "key", "항목"), el(doc, "th", "num", "광고"), el(doc, "th", "num", "추천"));
  head.append(headRow);
  const body = el(doc, "tbody");
  for (const [key, ad, suggested] of rows) {
    const tr = el(doc, "tr");
    const keyCell = el(doc, "td", "key", key);
    if (overCap.has(key)) {
      tr.dataset.overCap = "true";
      keyCell.append(el(doc, "span", "tag tag-stale", "그룹 상한"));
    }
    tr.append(keyCell, el(doc, "td", "num", ad), el(doc, "td", "num", suggested));
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

function siteBlock(doc: Document, site: SiteId, view: DiagnosticsView, wasOpen: boolean): HTMLElement {
  const raw = view.caches[site];
  const cache = isRecord(raw) ? raw : undefined;
  const entries = cache && isRecord(cache.entries) ? cache.entries : {};
  const rows = cache ? rowsOf(entries, cache.order) : [];
  const day = cache && typeof cache.day === "string" ? cache.day : "";
  const key = cache && typeof cache.providerKey === "string" ? cache.providerKey : "";
  const stale = cache !== undefined && (day !== view.day || key !== view.currentKey);
  const overCap = new Set((view.overCap?.[site] ?? []).filter((k) => Object.hasOwn(entries, k)));

  const block = el(doc, "section", "diag");
  block.id = `diag-${site}`;
  block.dataset.day = day;
  block.dataset.providerKey = key;
  block.title = key;
  block.dataset.rows = String(rows.length);
  block.dataset.stale = String(stale);
  block.dataset.overCap = String(overCap.size);

  const head = el(doc, "div", "diag-head");
  head.append(el(doc, "h3", "", SITE_LABELS[site]));
  if (!cache) head.append(el(doc, "span", "tag tag-none", "기록 없음"));
  else if (stale) head.append(el(doc, "span", "tag tag-stale", "현재 설정과 다름"));
  else head.append(el(doc, "span", "tag tag-fresh", "오늘"));
  if (overCap.size > 0) {
    head.append(el(doc, "span", "tag tag-stale", `그룹 상한 초과 항목 ${overCap.size}개`));
  }
  if (!cache) {
    block.append(head, el(doc, "p", "empty", "아직 이 사이트의 판정이 저장되지 않았습니다."));
    return block;
  }
  const meta = `날짜 ${day || "?"} · ${rows.length}개`;
  if (rows.length === 0) {
    block.append(head, el(doc, "p", "meta", meta), el(doc, "p", "empty", "저장된 판정이 없습니다."));
    return block;
  }
  const details = el(doc, "details");
  details.open = wasOpen || overCap.size > 0;
  const summary = el(doc, "summary");
  summary.append(head, el(doc, "div", "meta", meta));
  details.append(summary);
  if (overCap.size > 0) {
    details.append(el(doc, "p", "meta",
      "아래 '그룹 상한' 항목은 한 모델 판정이 한 페이지에서 상한을 넘는 항목에 걸렸습니다. " +
      "상한을 넘은 항목은 건드리지 않았습니다. 잘못된 판정이면 오늘 판정 기록을 비우세요."));
  }
  details.append(tableOf(doc, rows, overCap));
  block.append(details);
  return block;
}

const DECISION_LABEL: Record<OverrideDecision, string> = { keep: "광고 아님", confirmed: "광고 맞음" };

function overrideBlock(doc: Document, site: SiteId, map: OverrideMap): HTMLElement {
  const entries = Object.entries(map.entries);
  const block = el(doc, "section", "diag");
  block.id = `override-${site}`;
  block.dataset.count = String(entries.length);

  const head = el(doc, "div", "diag-head");
  head.append(el(doc, "h3", "", SITE_LABELS[site]), el(doc, "span", "tag tag-fresh", `${entries.length}개`));
  block.append(head);

  const table = el(doc, "table");
  const headRow = el(doc, "tr");
  headRow.append(
    el(doc, "th", "key", "항목"),
    el(doc, "th", "", "응답"),
    el(doc, "th", "", "날짜"),
    el(doc, "th", "", "")
  );
  const thead = el(doc, "thead");
  thead.append(headRow);
  const body = el(doc, "tbody");
  for (const [key, entry] of entries) {
    const row = el(doc, "tr");
    row.dataset.decision = entry.decision;
    const action = el(doc, "td");
    const button = el(doc, "button", "btn btn-row", "지우기");
    button.type = "button";
    button.dataset.site = site;
    button.dataset.key = key;
    action.append(button);
    row.append(
      el(doc, "td", "key", key),
      el(doc, "td", "", DECISION_LABEL[entry.decision]),
      el(doc, "td", "", today(new Date(entry.at))),
      action
    );
    body.append(row);
  }
  table.append(thead, body);
  block.append(table);
  return block;
}

export function renderOverrides(
  overrides: Partial<Record<SiteId, OverrideMap>>,
  root: ParentNode = document
): void {
  const doc = root.ownerDocument ?? (root as Document);
  const blocks: HTMLElement[] = [];
  let count = 0;
  for (const site of SITE_IDS) {
    const map = overrides[site];
    const entries = map ? Object.keys(map.entries).length : 0;
    if (!map || entries === 0) continue;
    count += entries;
    blocks.push(overrideBlock(doc, site, map));
  }
  const summary = $<HTMLElement>(root, "override-summary");
  summary.dataset.count = String(count);
  const label = el(doc, "span", "", "저장된 응답 ");
  label.append(el(doc, "strong", "", `${count}개`));
  summary.replaceChildren(label);
  $<HTMLButtonElement>(root, "override-clear-all").disabled = count === 0;
  $<HTMLElement>(root, "overrides").replaceChildren(
    ...(blocks.length > 0 ? blocks : [el(doc, "p", "empty", "아직 응답이 없습니다.")])
  );
}

const probability = (v: unknown): number | null => (typeof v === "number" ? v : null);

function freshVerdicts(view: DiagnosticsView, settings: Settings): { answered: number; hidden: number; blurred: number } {
  const actions = actionsOf(settings);
  const totals = { answered: 0, hidden: 0, blurred: 0 };
  for (const site of SITE_IDS) {
    const cache = view.caches[site];
    if (!isRecord(cache) || cache.day !== view.day || cache.providerKey !== view.currentKey || !isRecord(cache.entries)) continue;
    for (const entry of Object.values(cache.entries)) {
      const scores = isRecord(entry) ? entry : {};
      const action = combine(
        actionFor("ad", probability(scores.ad), actions),
        actionFor("suggested", probability(scores.suggested), actions)
      );
      totals.answered += 1;
      if (action === "hide") totals.hidden += 1;
      if (action === "blur") totals.blurred += 1;
    }
  }
  return totals;
}

function setTag(tag: HTMLElement, tone: "fresh" | "stale" | "none", text: string): void {
  tag.className = `tag tag-${tone}`;
  tag.textContent = text;
}

const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

function renderConnection(view: DiagnosticsView, settings: Settings, answered: number, root: ParentNode): void {
  const provider = PROVIDER_LABELS[settings.provider];
  const paused = typeof view.pausedUntil === "number" && view.pausedUntil > Date.now();
  const [state, tone, stateText, detail] =
    settings[settings.provider].apiKey.trim() === ""
      ? (["no-key", "stale", "키 없음", `아래에 ${provider} 키를 넣으면 바로 시작합니다.`] as const)
      : paused
        ? (["paused", "stale", "일시 중지", `요청 한도 또는 서버 오류로 ${clockTime(view.pausedUntil ?? 0)}까지 쉽니다.`] as const)
        : answered > 0
          ? (["answered", "fresh", "오늘 응답함", `${provider}가 오늘 ${answered}개 항목에 답했습니다.`] as const)
          : (["idle", "none", "아직 호출 전", "다음 피드 방문 때 확인됩니다."] as const);
  $<HTMLElement>(root, "connection").dataset.state = state;
  setTag($<HTMLElement>(root, "connection-state"), tone, stateText);
  $<HTMLElement>(root, "connection-detail").textContent = detail;
  for (const p of PROVIDERS) {
    const saved = settings[p].apiKey.trim() !== "";
    setTag($<HTMLElement>(root, `${p}-key-state`), saved ? "fresh" : "stale", saved ? "저장됨" : "키 없음");
  }
}

export function renderDiagnostics(view: DiagnosticsView, root: ParentNode = document): void {
  const doc = root.ownerDocument ?? (root as Document);
  const used = Number.isFinite(view.budgetUsed) && view.budgetUsed >= 0 ? view.budgetUsed : 0;
  const settings = view.settings ?? DEFAULT_SETTINGS;
  const ratio = Math.min(used / DAILY_REQUEST_BUDGET, 1);

  const budget = $<HTMLElement>(root, "budget");
  budget.dataset.used = String(used);
  budget.dataset.limit = String(DAILY_REQUEST_BUDGET);
  budget.dataset.level = ratio >= BUDGET_WARNING_RATIO ? "high" : "normal";
  $<HTMLElement>(root, "budget-count").textContent = `${used} / ${DAILY_REQUEST_BUDGET}`;
  $<HTMLElement>(root, "budget-key").title = view.currentKey;
  const meter = $<HTMLElement>(root, "budget-meter");
  meter.setAttribute("aria-valuenow", String(used));
  meter.setAttribute("aria-valuemax", String(DAILY_REQUEST_BUDGET));
  $<HTMLElement>(root, "budget-fill").style.transform = `scaleX(${ratio})`;

  const verdicts = freshVerdicts(view, settings);
  renderConnection(view, settings, verdicts.answered, root);
  $<HTMLElement>(root, "filtered-hidden").textContent = String(verdicts.hidden);
  $<HTMLElement>(root, "filtered-blurred").textContent = String(verdicts.blurred);

  const diagnostics = $<HTMLElement>(root, "diagnostics");
  const opened = new Set(Array.from(diagnostics.querySelectorAll("details[open]"), (d) => d.closest("section")?.id));
  diagnostics.replaceChildren(...SITE_IDS.map((site) => siteBlock(doc, site, view, opened.has(`diag-${site}`))));
}

export async function loadDiagnostics(settings: Settings): Promise<DiagnosticsView> {
  const day = today();
  const caches: Partial<Record<SiteId, unknown>> = {};
  const overCap: Partial<Record<SiteId, readonly string[]>> = {};
  const answers: Partial<Record<SiteId, OverrideMap>> = {};
  const loaded = await Promise.all(SITE_IDS.map((site) => loadSigCache(site)));
  const capped = await Promise.all(SITE_IDS.map((site) => loadOverCap(site, day)));
  const stored = await Promise.all(SITE_IDS.map((site) => loadOverrides(site)));
  SITE_IDS.forEach((site, i) => {
    caches[site] = loaded[i];
    overCap[site] = capped[i];
    answers[site] = stored[i];
  });
  const key = budgetKey(day);
  const budget = (await chrome.storage.local.get(key))[key] as unknown;
  const count = isRecord(budget) ? budget.count : undefined;
  const pausedUntil = (await chrome.storage.local.get(PAUSE_STORAGE_KEY))[PAUSE_STORAGE_KEY] as unknown;
  return {
    settings,
    ...(typeof pausedUntil === "number" ? { pausedUntil } : {}),
    day,
    currentKey: providerKey(settings),
    caches,
    overCap,
    overrides: answers,
    budgetUsed: typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : 0
  };
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function main(root: ParentNode = document): Promise<void> {
  const form = $<HTMLFormElement>(root, "settings");
  const status = $<HTMLElement>(root, "status");
  let chipTimer: ReturnType<typeof setTimeout> | undefined;
  const note = (state: "saving" | "saved" | "reset" | "error", message: string) => {
    clearTimeout(chipTimer);
    status.textContent = message;
    status.dataset.state = state;
    status.dataset.shown = "true";
    if (state === "saved" || state === "reset") {
      chipTimer = setTimeout(() => delete status.dataset.shown, SAVED_CHIP_MS);
    }
  };
  const refresh = async () => {
    const view = await loadDiagnostics(await loadSettings());
    renderDiagnostics(view, root);
    renderOverrides(view.overrides ?? {}, root);
  };

  let pendingSave: ReturnType<typeof setTimeout> | undefined;
  const save = async () => {
    clearTimeout(pendingSave);
    pendingSave = undefined;
    try {
      const settings = collectForm(root);
      populateForm(settings, root);
      await chrome.storage.local.set({ settings });
      await refresh();
      if (pendingSave === undefined) note("saved", "저장했습니다. 다음 페이지 이동부터 적용됩니다.");
    } catch (err) {
      note("error", `저장 실패: ${describe(err)}`);
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  form.addEventListener("change", () => void save());
  for (const id of ["openai-key", "typesafe-key"]) {
    input(root, id).addEventListener("input", () => {
      note("saving", "저장 중…");
      clearTimeout(pendingSave);
      pendingSave = setTimeout(() => void save(), KEY_TYPING_DEBOUNCE_MS);
    });
  }
  (root.ownerDocument ?? (root as Document)).defaultView?.addEventListener("pagehide", () => {
    if (pendingSave !== undefined) void save();
  });

  $<HTMLButtonElement>(root, "reset").addEventListener("click", () => {
    void (async () => {
      try {
        const msg: Message = { type: "reset" };
        await chrome.runtime.sendMessage(msg);
        await refresh();
        note("reset", "오늘 판정 기록을 비웠습니다. 다음 페이지 이동부터 다시 판정합니다.");
      } catch (err) {
        note("error", `판정 기록 비우기 실패: ${describe(err)}`);
      }
    })();
  });

  $<HTMLElement>(root, "overrides").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button[data-key]") : null;
    const site = target?.dataset.site;
    const key = target?.dataset.key;
    if (key === undefined || site === undefined || !(SITE_IDS as readonly string[]).includes(site)) return;
    void (async () => {
      try {
        await clearOverride(site as SiteId, key);
        await refresh();
        note("reset", "응답 1개를 지웠습니다. 다음 페이지 이동부터 다시 판정합니다.");
      } catch (err) {
        note("error", `응답 지우기 실패: ${describe(err)}`);
      }
    })();
  });

  $<HTMLButtonElement>(root, "override-clear-all").addEventListener("click", () => {
    void (async () => {
      try {
        await clearOverrides(SITE_IDS);
        await refresh();
        note("reset", "저장된 응답을 모두 지웠습니다. 다음 페이지 이동부터 다시 판정합니다.");
      } catch (err) {
        note("error", `응답 지우기 실패: ${describe(err)}`);
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
