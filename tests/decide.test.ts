import { expect, test } from "bun:test";
import { actionFor, actionsOf, combine, ITEM_CSS, placement, today } from "../src/decide";
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

test("actionsOf: ads are always hidden, recommendations follow the one switch", () => {
  expect(actionsOf(true)).toEqual({ ad: "hide", suggested: "hide" });
  expect(actionsOf(false)).toEqual({ ad: "hide", suggested: "keep" });
  expect(actionFor("suggested", 0.9, actionsOf(false))).toBe("keep");
  expect(actionFor("ad", 0.9, actionsOf(false))).toBe("hide");
});

test("combine: hide > blur > keep, in any order", () => {
  const all: Action[] = ["keep", "blur", "cover", "hide"];
  const rank: Record<Action, number> = { keep: 0, blur: 1, cover: 2, hide: 3 };
  for (const a of all) {
    for (const b of all) {
      expect(combine(a, b)).toBe(rank[a] >= rank[b] ? a : b);
      expect(combine(a, b)).toBe(combine(b, a));
    }
  }
});

const pos = (pageHasPainted: boolean, top: number, viewportHeight = 800) => ({ pageHasPainted, top, viewportHeight });

test("placement: page not painted, in viewport hide -> hide", () => {
  expect(placement("hide", pos(false, 100))).toBe("hide");
  expect(placement("hide", pos(false, 0))).toBe("hide");
});

test("placement: page painted, in viewport hide -> cover", () => {
  expect(placement("hide", pos(true, 100))).toBe("cover");
  expect(placement("hide", pos(true, 0))).toBe("cover");
});

test("placement: page painted, top >= viewport height -> hide", () => {
  expect(placement("hide", pos(true, 800))).toBe("hide");
  expect(placement("hide", pos(true, 5000))).toBe("hide");
});

test("placement: boundary painted top = vh - 1 -> cover", () => {
  expect(placement("hide", pos(true, 799))).toBe("cover");
});

test("placement: page painted, above viewport -> cover", () => {
  expect(placement("hide", pos(true, -1))).toBe("cover");
  expect(placement("hide", pos(true, -3000))).toBe("cover");
});

test("placement: page not painted, above viewport -> hide", () => {
  expect(placement("hide", pos(false, -1))).toBe("hide");
});

test("placement: keep stays keep, blur stays blur", () => {
  for (const painted of [true, false]) {
    for (const top of [-500, 0, 100, 799, 800, 5000]) {
      expect(placement("keep", pos(painted, top))).toBe("keep");
      expect(placement("cover", pos(painted, top))).toBe("cover");
    }
  }
});

test("placement: NaN top never hides, even before first paint", () => {
  expect(placement("hide", pos(true, Number.NaN))).toBe("cover");
  expect(placement("hide", pos(false, Number.NaN))).toBe("cover");
  expect(placement("hide", pos(true, 100, Number.NaN))).toBe("cover");
});

test("placement: negative top with nonsense viewport is never trusted to be off-screen", () => {
  expect(placement("hide", pos(true, -1, -1))).toBe("cover");
  expect(placement("hide", pos(true, -100, 800))).toBe("cover");
});

test("ITEM_CSS targets both treatment attributes and nothing else", () => {
  expect(ITEM_CSS).toContain('[data-jev="hide"]{display:none!important}');
  expect(ITEM_CSS).toContain("[data-jev=\"blur\"]{filter:blur(10px)!important;opacity:.4!important;pointer-events:none!important;contain:paint!important}");
  expect(ITEM_CSS).not.toContain('[data-jev="keep"]');
});
