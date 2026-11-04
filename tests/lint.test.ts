import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSync } from "oxc-parser";

const ROOT = join(import.meta.dir, "..");
const CONFIG = join(ROOT, ".oxlintrc.json");
const RULE_ID = "no-comments(no-comments)";
const SPAWN_TIMEOUT_MS = 30_000;
const SCRATCH = mkdtempSync(join(tmpdir(), "jev-lint-"));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Diagnostic {
  code: string;
}

interface LintResult {
  exitCode: number;
  ruleCount: number;
}

async function lint(name: string, source: string): Promise<LintResult> {
  const file = join(SCRATCH, name);
  writeFileSync(file, source);
  const proc = Bun.spawn([process.execPath, "x", "oxlint", "-c", CONFIG, "-f", "json", file], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: SPAWN_TIMEOUT_MS,
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const report = JSON.parse(stdout) as { diagnostics: Diagnostic[] };
  return { exitCode, ruleCount: report.diagnostics.filter((d) => d.code === RULE_ID).length };
}

function parsedCommentCount(name: string, source: string): number {
  return parseSync(join(SCRATCH, name), source).comments.length;
}

describe("no-comments rule", () => {
  test("a trailing line comment is one diagnostic and a failing exit", async () => {
    const result = await lint("trailing.ts", "export const a = 1; // x\n");
    expect(result.ruleCount).toBe(1);
    expect(result.exitCode).not.toBe(0);
  });

  test("line, block and JSDoc comments are three diagnostics", async () => {
    const result = await lint("kinds.ts", "// a\n/* b */\n/** c */\nexport const a = 1;\n");
    expect(result.ruleCount).toBe(3);
    expect(result.exitCode).not.toBe(0);
  });

  test("comment-looking string and regex literals are zero diagnostics", async () => {
    const result = await lint("literals.ts", 'export const a = ["http://x", "/* no */", /\\/\\//];\n');
    expect(result.ruleCount).toBe(0);
    expect(result.exitCode).toBe(0);
  });
});

type Gate = "oxlint" | "parse";

interface DirectiveCase {
  name: string;
  source: string;
  gate: Gate;
}

const DIRECTIVE_CASES: DirectiveCase[] = ["oxlint", "eslint"].flatMap((tool) => [
  { name: `${tool}-disable`, source: `// ${tool}-disable\nexport const a = 1;\n`, gate: "oxlint" as const },
  { name: `${tool}-disable-line`, source: `export const a = 1; // ${tool}-disable-line\n`, gate: "parse" as const },
  {
    name: `${tool}-disable-next-line`,
    source: `// ${tool}-disable-next-line\nexport const a = 1; // other\n`,
    gate: "oxlint" as const,
  },
  { name: `${tool}-disable-block`, source: `/* ${tool}-disable */ export const a = 1;\n`, gate: "parse" as const },
]);

describe("lint directives never hide a comment", () => {
  for (const directive of DIRECTIVE_CASES) {
    test(`${directive.name} is caught by the ${directive.gate} gate`, async () => {
      const file = `${directive.name}.ts`;
      if (directive.gate === "oxlint") {
        const result = await lint(file, directive.source);
        expect(result.ruleCount).toBeGreaterThanOrEqual(1);
        expect(result.exitCode).not.toBe(0);
        return;
      }
      expect(parsedCommentCount(file, directive.source)).toBeGreaterThanOrEqual(1);
    });
  }
});
