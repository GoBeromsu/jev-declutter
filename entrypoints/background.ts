import { defineBackground } from "wxt/utils/define-background";
import { startBackground } from "../src/background";

export default defineBackground(() => {
  startBackground();
  // Dev only: the WXT Chrome opens the settings page next to the feed. A hot reload closes it;
  // the toolbar icon reopens it.
  if (import.meta.env.DEV)
    chrome.runtime.onInstalled.addListener(({ reason }) => reason === "install" && chrome.runtime.openOptionsPage());
});
