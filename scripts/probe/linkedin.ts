import { join } from "node:path";
import type { DriftCounts } from "./linkedin-count";

const FEED_URL = "https://www.linkedin.com/feed/";
const SCROLL_STEPS = 10;
const SCROLL_PX = 900;
const GROWTH_TIMEOUT_MS = 2500;
const MARK = "JEV_PROBE_JSON";

export interface ProbeReport {
  probe: "linkedin-react-drift";
  ok: boolean;
  checks: {
    sawItems: boolean;
    adDetectedAll: boolean;
    noFalseMarks: boolean;
  };
  scrollSteps: number;
  scrollPx: number;
  scrolledMainWorkspace: boolean;
  itemsBeforeScroll: number;
  counts: DriftCounts;
}

export async function buildPageBundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "page-entry.ts")],
    target: "browser",
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
