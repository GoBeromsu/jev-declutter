import { defineBackground } from "wxt/utils/define-background";
import { startBackground } from "../src/background";

export default defineBackground(() => {
  startBackground();
  if (import.meta.env.DEV)
    chrome.runtime.onInstalled.addListener(({ reason }) => reason === "install" && chrome.runtime.openOptionsPage());
});
