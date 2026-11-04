import { defineConfig } from "wxt";

export default defineConfig({
  imports: false,
  webExt: {
    chromiumProfile: ".wxt/chrome-profile",
    keepProfileChanges: true,
    chromiumArgs: ["--remote-debugging-port=9222"],
    startUrls: ["https://www.instagram.com/"]
  },
  manifest: {
    name: "Jev Declutter",
    description: "Remove or blur ads, not-followed recommendations and recommendation modules in the YouTube, X, Instagram and LinkedIn feeds.",
    minimum_chrome_version: "123",
    permissions: ["storage"],
    host_permissions: ["https://api.openai.com/*", "https://api.typesafe.ai/*"],
    action: { default_title: "Jev Declutter settings" }
  }
});
