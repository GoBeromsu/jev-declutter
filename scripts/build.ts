import { existsSync } from "node:fs";
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
// Copy the CONTENTS of public/ so manifest.json sits at the dist root, where an unpacked load finds it.
await cp("public", "dist", { recursive: true });
for (const required of ["manifest.json", "options.html"]) {
  if (!existsSync(`dist/${required}`)) {
    console.error(`build layout is wrong: dist/${required} is missing`);
    process.exit(1);
  }
}
console.log(`built ${result.outputs.length} bundles into dist/`);
