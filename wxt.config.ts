import { defineConfig } from "wxt";

export default defineConfig({
  imports: false,
  // Load .output/chrome-mv3-dev into Aside once (Load unpacked); `wxt dev` then hot-reloads it.
  webExt: { disabled: true },
  manifest: {
    name: "Jev Declutter",
    description: "Remove or blur ads, not-followed recommendations and recommendation modules in the YouTube, X, Instagram and LinkedIn feeds.",
    permissions: ["storage"],
    host_permissions: ["https://api.openai.com/*", "https://api.typesafe.ai/*"],
    action: { default_title: "Jev Declutter settings" }
  }
});
