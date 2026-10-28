import { cp, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/background.ts", "src/content.ts", "src/options.ts"],
  outdir: "dist",
  target: "browser",
  // Content scripts cannot be ES modules; IIFE keeps every entry self-contained.
  format: "iife"
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp("public", "dist", { recursive: true });
console.log(`built ${result.outputs.length} bundles into dist/`);
