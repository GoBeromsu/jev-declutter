import { defineContentScript } from "wxt/utils/define-content-script";
import { startContent } from "../src/content";

export default defineContentScript({
  matches: [
    "https://www.youtube.com/*",
    "https://x.com/*",
    "https://twitter.com/*",
    "https://www.instagram.com/*",
    "https://www.linkedin.com/*"
  ],
  runAt: "document_start",
  main: () => startContent()
});
