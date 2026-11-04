import { expect, test } from "bun:test";
import { actionFor, actionsOf, combine, ITEM_CSS, onScreen, today } from "../src/decide";
import type { Action, Category } from "../src/types";

const DEFAULT_ACTIONS: Record<Category, Action> = { ad: "hide", suggested: "hide" };
const ALL_KEEP: Record<Category, Action> = { ad: "keep", suggested: "keep" };

test("today uses the local calendar day", () => {
  expect(today(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
});

test("actionFor: null probability is keep", () => {
  expect(actionFor("ad", null, DEFAULT_ACTIONS)).toBe("keep");
  expect(actionFor("ad", null, ALL_KEEP)).toBe("keep");
});

test("actionFor: NaN probability is keep, never a loud action", () => {
  expect(actionFor("ad", Number.NaN, DEFAULT_ACTIONS)).toBe("keep");
});

test("actionFor: thresholds pick settings action, blur, keep", () => {
  expect(actionFor("ad", 0.8, DEFAULT_ACTIONS)).toBe("hide");
  expect(actionFor("ad", 0.99, DEFAULT_ACTIONS)).toBe("hide");
  expect(actionFor("ad", 0.79, DEFAULT_ACTIONS)).toBe("blur");
  expect(actionFor("ad", 0.5, DEFAULT_ACTIONS)).toBe("blur");
  expect(actionFor("ad", 0.49, DEFAULT_ACTIONS)).toBe("keep");
  expect(actionFor("ad", 0, DEFAULT_ACTIONS)).toBe("keep");
});

test("actionFor: settings keep wins over every probability", () => {
  expect(actionFor("suggested", 0.95, ALL_KEEP)).toBe("keep");
  expect(actionFor("ad", 0.6, ALL_KEEP)).toBe("keep");
});

test("actionsOf: ads and recommendations each follow their own switch", () => {
  expect(actionsOf({ hideAds: true, hideSuggested: true })).toEqual({ ad: "hide", suggested: "hide" });
  expect(actionsOf({ hideAds: true, hideSuggested: false })).toEqual({ ad: "hide", suggested: "keep" });
  expect(actionsOf({ hideAds: false, hideSuggested: true })).toEqual({ ad: "keep", suggested: "hide" });
  expect(actionFor("ad", 0.9, actionsOf({ hideAds: false, hideSuggested: true }))).toBe("keep");
});

test("combine: hide > blur > keep, in any order", () => {
  const all: Action[] = ["keep", "blur", "hide"];
  const rank: Record<Action, number> = { keep: 0, blur: 1, hide: 2 };
  for (const a of all) {
    for (const b of all) {
      expect(combine(a, b)).toBe(rank[a] >= rank[b] ? a : b);
      expect(combine(a, b)).toBe(combine(b, a));
    }
  }
});

const pos = (pageHasPainted: boolean, top: number, viewportHeight = 800) => ({ pageHasPainted, top, viewportHeight });

test("onScreen: only after first paint, inside or above the viewport", () => {
  expect(onScreen(pos(false, 100))).toBe(false);
  expect(onScreen(pos(false, -1))).toBe(false);
  expect(onScreen(pos(true, 0))).toBe(true);
  expect(onScreen(pos(true, 799))).toBe(true);
  expect(onScreen(pos(true, -3000))).toBe(true);
  expect(onScreen(pos(true, 800))).toBe(false);
  expect(onScreen(pos(true, 5000))).toBe(false);
});

test("onScreen: NaN or nonsense geometry is never trusted to be off-screen", () => {
  expect(onScreen(pos(false, Number.NaN))).toBe(true);
  expect(onScreen(pos(true, 100, Number.NaN))).toBe(true);
  expect(onScreen(pos(true, -1, -1))).toBe(true);
});

test("ITEM_CSS targets both treatment attributes and nothing else", () => {
  expect(ITEM_CSS).toContain('[data-jev="hide"]{display:none!important}');
  expect(ITEM_CSS).toContain("[data-jev=\"blur\"]:not([role=\"presentation\"]){filter:blur(10px)!important;opacity:.4!important;pointer-events:none!important;contain:paint!important}");
  expect(ITEM_CSS).not.toContain('[data-jev="keep"]');
});
