import { defineConfig } from "wxt";

export default defineConfig({
  imports: false,
  // `wxt dev` opens its own Chrome with the dev build loaded. The profile persists (API key, logins).
  webExt: { chromiumProfile: ".wxt/chrome-profile", keepProfileChanges: true, startUrls: ["https://www.instagram.com/"] },
  manifest: {
    name: "Jev Declutter",
    description: "Remove or blur ads, not-followed recommendations and recommendation modules in the YouTube, X, Instagram and LinkedIn feeds.",
    permissions: ["storage"],
    host_permissions: ["https://api.openai.com/*", "https://api.typesafe.ai/*"],
    action: { default_title: "Jev Declutter settings" }
  }
});
