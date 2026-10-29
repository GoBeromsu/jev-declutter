import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(ROOT, "public", "manifest.json");

interface Manifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  description?: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  content_scripts?: { matches?: string[]; js?: string[]; css?: string[]; run_at?: string }[];
  [key: string]: unknown;
}

export function loadManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function manifestIssues(m: Manifest): string[] {
  const issues: string[] = [];
  const text = `${m.name ?? ""} ${m.description ?? ""}`;
  for (const site of ["YouTube", "X", "Instagram", "LinkedIn"]) {
    if (!text.includes(site)) issues.push(`name/description do not mention ${site}`);
  }
  if (m.version !== "0.2.0") issues.push(`version is ${String(m.version)}, expected 0.2.0`);

  const hosts = [...(m.host_permissions ?? [])].sort();
  const expectedHosts = ["https://api.openai.com/*", "https://api.typesafe.ai/*"];
  if (JSON.stringify(hosts) !== JSON.stringify(expectedHosts)) {
    issues.push(`host_permissions are ${JSON.stringify(m.host_permissions)}, expected exactly ${JSON.stringify(expectedHosts)}`);
  }

  const scripts = m.content_scripts ?? [];
  if (scripts.length === 0) issues.push("no content_scripts");
  scripts.forEach((cs, i) => {
    if (!cs.matches?.includes("https://www.linkedin.com/*")) issues.push(`content_scripts[${i}] lacks the linkedin match`);
    if (!cs.js?.includes("content.js")) issues.push(`content_scripts[${i}] lacks content.js`);
    if ("css" in cs) issues.push(`content_scripts[${i}] has a css entry`);
    if (cs.run_at !== "document_start") issues.push(`content_scripts[${i}] run_at is ${String(cs.run_at)}`);
  });

  const declared = [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];
  for (const forbidden of ["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback", "webRequest", "webRequestBlocking", "scripting", "tabs"]) {
    if (declared.includes(forbidden)) issues.push(`forbidden permission ${forbidden}`);
  }
  if (!declared.includes("storage")) issues.push("storage permission missing");
  for (const key of ["declarative_net_request", "web_accessible_resources"]) {
    if (key in m) issues.push(`forbidden manifest key ${key}`);
  }
  return issues;
}

describe("public/manifest.json", () => {
  const manifest = loadManifest();

  test("is valid MV3 without forbidden surface", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifestIssues(manifest)).toEqual([]);
  });

  test("linkedin match, both host permissions, no css entry", () => {
    const [cs] = manifest.content_scripts ?? [];
    expect(cs?.matches).toContain("https://www.linkedin.com/*");
    expect(cs?.css).toBeUndefined();
    expect(manifest.host_permissions).toContain("https://api.openai.com/*");
    expect(manifest.host_permissions).toContain("https://api.typesafe.ai/*");
  });

  test("mutation: removing the linkedin match is reported", () => {
    const mutated = structuredClone(manifest);
    const cs = mutated.content_scripts?.[0];
    if (!cs) throw new Error("no content_scripts to mutate");
    cs.matches = (cs.matches ?? []).filter((u) => !u.includes("linkedin"));
    expect(manifestIssues(mutated)).toContain("content_scripts[0] lacks the linkedin match");
  });

  test("build layout: the real build puts manifest.json and options.html at the dist root", async () => {
    const out = mkdtempSync(join(tmpdir(), "jev-build-layout-"));
    try {
      await cp(join(ROOT, "src"), join(out, "src"), { recursive: true });
      await cp(join(ROOT, "public"), join(out, "public"), { recursive: true });
      await cp(join(ROOT, "scripts", "build.ts"), join(out, "scripts", "build.ts"));
      mkdirSync(join(out, "dist"));
      const build = Bun.spawn([process.execPath, "run", "scripts/build.ts"], {
        cwd: out,
        stdout: "pipe",
        stderr: "pipe"
      });
      const [stdout, stderr] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
      const exitCode = await build.exited;
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });

      const manifestAtRoot = join(out, "dist", "manifest.json");
      expect(existsSync(manifestAtRoot)).toBe(true);
      expect(existsSync(join(out, "dist", "options.html"))).toBe(true);
      for (const bundle of ["background.js", "content.js", "options.js"]) {
        expect(existsSync(join(out, "dist", bundle))).toBe(true);
      }
      expect(existsSync(join(out, "dist", "public"))).toBe(false);
      const shipped = JSON.parse(readFileSync(manifestAtRoot, "utf8")) as Manifest;
      expect(shipped.content_scripts?.[0]?.matches).toContain("https://www.linkedin.com/*");
      expect(manifestIssues(shipped)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  test("mutation: a css entry and a forbidden permission are reported", () => {
    const mutated = structuredClone(manifest);
    const cs = mutated.content_scripts?.[0];
    if (!cs) throw new Error("no content_scripts to mutate");
    cs.css = ["modules.css"];
    mutated.permissions = [...(mutated.permissions ?? []), "scripting"];
    const issues = manifestIssues(mutated);
    expect(issues).toContain("content_scripts[0] has a css entry");
    expect(issues).toContain("forbidden permission scripting");
  });
});
