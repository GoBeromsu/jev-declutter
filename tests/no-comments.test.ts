import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseSync } from "oxc-parser";

const ROOT = join(import.meta.dir, "..");
const DIRECTORIES = ["src", "entrypoints", "scripts", "tests", "lint"];
const EXTRA_FILES = ["wxt.config.ts"];
const FIXTURES_PREFIX = "tests/fixtures/";

async function sourceFiles(): Promise<string[]> {
  const glob = new Bun.Glob("**/*.{ts,js}");
  const scanned = await Promise.all(
    DIRECTORIES.map(async (directory) => {
      const files = await Array.fromAsync(glob.scan({ cwd: join(ROOT, directory) }));
      return files.map((file) => `${directory}/${file}`);
    })
  );
  return [...EXTRA_FILES, ...scanned.flat()].filter((relative) => !relative.startsWith(FIXTURES_PREFIX)).sort();
}

test("no TypeScript or JavaScript source file contains a comment", async () => {
  const files = await sourceFiles();
  expect(files.length).toBeGreaterThan(EXTRA_FILES.length);
  const counted = await Promise.all(
    files.map(async (relative) => {
      const path = join(ROOT, relative);
      const text = await Bun.file(path).text();
      return { relative, comments: parseSync(path, text).comments.length };
    })
  );
  const withComments = counted.filter((entry) => entry.comments > 0).map((entry) => entry.relative);
  expect(withComments).toEqual([]);
});
