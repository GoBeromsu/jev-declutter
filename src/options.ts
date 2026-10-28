import { loadCache, loadSettings } from "./storage";
import type { Message, SiteId } from "./types";

const SITE_IDS: SiteId[] = ["youtube", "x", "instagram"];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string) => ($("status").textContent = text);

async function render() {
  const settings = await loadSettings();
  $<HTMLInputElement>("apiKey").value = settings.apiKey;
  $<HTMLInputElement>("model").value = settings.model;
  for (const site of SITE_IDS) $<HTMLTextAreaElement>(`goal-${site}`).value = settings.goals[site];

  const root = $("decisions");
  root.replaceChildren();
  for (const site of SITE_IDS) {
    const cache = await loadCache(site);
    const h = document.createElement("h3");
    h.textContent = cache ? `${site} - ${cache.day} - ${cache.model}` : `${site} - not cached yet`;
    root.append(h);
    if (!cache) continue;
    const table = document.createElement("table");
    table.innerHTML = "<tr><th>action</th><th>distracting</th><th>essential</th><th>component</th></tr>";
    for (const d of cache.decisions) {
      const row = table.insertRow();
      row.insertCell().textContent = d.action;
      row.insertCell().textContent = d.distracting.toFixed(2);
      row.insertCell().textContent = d.essential.toFixed(2);
      const cell = row.insertCell();
      cell.textContent = d.description + " ";
      const code = document.createElement("code");
      code.textContent = d.selector;
      cell.append(code);
    }
    root.append(table);
  }
}

$("save").addEventListener("click", async () => {
  const goals = Object.fromEntries(SITE_IDS.map((s) => [s, $<HTMLTextAreaElement>(`goal-${s}`).value.trim()]));
  await chrome.storage.local.set({
    settings: { apiKey: $<HTMLInputElement>("apiKey").value.trim(), model: $<HTMLInputElement>("model").value.trim() || "jev-latest", goals }
  });
  status("Saved. Goals apply from the next refresh.");
});

$("reset").addEventListener("click", async () => {
  const msg: Message = { type: "reset" };
  await chrome.runtime.sendMessage(msg);
  status("Cache cleared. Reload a site to ask Jev again.");
  await render();
});

render();
