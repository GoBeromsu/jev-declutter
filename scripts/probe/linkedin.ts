// Maintainer-run LinkedIn React feed drift probe.
//
//   bun run scripts/probe/linkedin.ts            # prints one JSON object of counts, exits 1 on drift
//
// It opens https://www.linkedin.com/feed/ in the owner's own Aside browser through `aside repl`,
// scrolls the feed, evaluates the counting module of ./linkedin-count.ts in the page, closes its
// tab, and prints counts. Nothing else: no click, no form, no storage write, no request, and no
// dependency on dist/ or on the extension being loaded - it re-runs the shipped extractSignals +
// deterministic over the live DOM and compares them with an independent ground truth.
//
// PRIVACY: the only thing printed is the JSON object below - integers and booleans. Page text
// never leaves the tab. `aside repl` itself echoes the tab title and URL on its own stdout, so
// that stdout is parsed for the counts line and is NEVER forwarded, logged or saved, not even on
// failure; rerun the repl by hand to debug.

import { join } from "node:path";
import type { DriftCounts } from "./linkedin-count";

const FEED_URL = "https://www.linkedin.com/feed/";
/** 10 x 900 px reaches ~25-30 items on a live feed, well inside `aside repl`'s 120 s budget. */
const SCROLL_STEPS = 10;
const SCROLL_PX = 900;
/** Per-step bound for the feed to append items. A step that times out just means no new items. */
const GROWTH_TIMEOUT_MS = 2500;
/** Marks the one line of the repl's stdout the runner reads. */
const MARK = "JEV_PROBE_JSON";

export interface ProbeReport {
  probe: "linkedin-react-drift";
  ok: boolean;
  checks: {
    /** The item selector still matches something: without this an empty page would pass vacuously. */
    sawItems: boolean;
    /** Every ground-truth ad marker was detected by the shipped config. A false here IS the drift. */
    adDetectedAll: boolean;
    /** No markerless item was marked. */
    noFalseMarks: boolean;
  };
  scrollSteps: number;
  scrollPx: number;
  /** Whether `main#workspace` is itself the scrolling box (false = the page scrolls). */
  scrolledMainWorkspace: boolean;
  itemsBeforeScroll: number;
  counts: DriftCounts;
}

/** Bundles the browser-side entry into one self-contained IIFE string. */
export async function buildPageBundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "page-entry.ts")],
    target: "browser",
    // The page gets one evaluated expression, so the bundle must not rely on module loading.
    format: "iife"
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    throw new Error("probe page bundle failed to build");
  }
  const out = built.outputs[0];
  if (out === undefined) throw new Error("probe page bundle produced no output");
  return await out.text();
}

/** The `aside repl` program. Every page value crossing back is a number, a boolean or DriftCounts. */
export function replScript(bundle: string): string {
  const install = `(() => {\n${bundle}\n; return typeof window.__jevProbe; })()`;
  return [
    `const probeInstall = ${JSON.stringify(install)};`,
    `const probeTab = await openTab(${JSON.stringify(FEED_URL)});`,
    `let probeReport = null;`,
    `try {`,
    `  if (await probeTab.evaluate(probeInstall) !== "object") throw new Error("probe global missing");`,
    `  const probeBefore = await probeTab.evaluate("window.__jevProbe.items()");`,
    `  let probeMain = false;`,
    `  for (let probeStep = 0; probeStep < ${SCROLL_STEPS}; probeStep++) {`,
    `    const probeSeen = await probeTab.evaluate("window.__jevProbe.items()");`,
    `    probeMain = await probeTab.evaluate("window.__jevProbe.scroll(${SCROLL_PX})");`,
    // Waits on the feed's own growth, not on a clock. A timeout means the feed appended nothing
    // for this step (end of feed, or a slow fetch) - the counts stay valid either way.
    `    await probeTab`,
    `      .waitForFunction("window.__jevProbe.items() > " + probeSeen, null, { timeout: ${GROWTH_TIMEOUT_MS} })`,
    `      .catch(() => {});`,
    `  }`,
    `  probeReport = {`,
    `    scrollSteps: ${SCROLL_STEPS},`,
    `    scrollPx: ${SCROLL_PX},`,
    `    scrolledMainWorkspace: probeMain,`,
    `    itemsBeforeScroll: probeBefore,`,
    `    counts: await probeTab.evaluate("window.__jevProbe.count()")`,
    `  };`,
    `} finally {`,
    `  await closeTab(probeTab);`,
    `}`,
    `console.log(${JSON.stringify(MARK)} + " " + JSON.stringify(probeReport));`
  ].join("\n");
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Reads the counts line out of the repl's stdout. Returns null when the probe did not report. */
export function parseReplOutput(stdout: string): Omit<ProbeReport, "probe" | "ok" | "checks"> | null {
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(ANSI, "").trim();
    if (!line.startsWith(MARK)) continue;
    const parsed: unknown = JSON.parse(line.slice(MARK.length).trim());
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as Omit<ProbeReport, "probe" | "ok" | "checks">;
  }
  return null;
}

export function reportFor(body: Omit<ProbeReport, "probe" | "ok" | "checks">): ProbeReport {
  const { counts } = body;
  const checks = {
    sawItems: counts.itemsSeen > 0,
    adDetectedAll: counts.adDetected === counts.adMarkerItems,
    noFalseMarks: counts.organicFalseMarked === 0
  };
  return {
    probe: "linkedin-react-drift",
    ok: checks.sawItems && checks.adDetectedAll && checks.noFalseMarks,
    checks,
    ...body
  };
}

if (import.meta.main) {
  const script = replScript(await buildPageBundle());
  const proc = Bun.spawn(["aside", "repl", script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const body = parseReplOutput(stdout);
  if (body === null) {
    // Deliberately no output echo: the repl's stdout carries the tab title and URL.
    console.error(
      `aside repl exited ${exitCode} without a ${MARK} line (${stdout.length} bytes of output withheld: it ` +
        `contains the tab title). Rerun 'aside repl' by hand to see why, or check that Aside is signed in.`
    );
    process.exit(1);
  }
  const report = reportFor(body);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
