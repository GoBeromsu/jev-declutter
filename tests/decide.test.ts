import { expect, test } from "bun:test";
import { decide, renderCss, today } from "../src/decide";
import { buildQuestions } from "../src/jev";
import type { Decision } from "../src/types";

test("essential components are always kept", () => {
  expect(decide(0.99, 0.9)).toBe("keep");
});

test("distraction thresholds pick hide, blur, keep", () => {
  expect(decide(0.85, 0.1)).toBe("hide");
  expect(decide(0.6, 0.1)).toBe("blur");
  expect(decide(0.2, 0.1)).toBe("keep");
});

test("renderCss is order-independent and skips kept components", () => {
  const d = (selector: string, action: Decision["action"]): Decision => ({ selector, description: "", action, distracting: 0, essential: 0 });
  const a = [d("b", "blur"), d("a", "hide"), d("c", "keep")];
  const css = renderCss(a);
  expect(css).toBe(renderCss([...a].reverse()));
  expect(css.split("\n").map((l) => l.split(" ")[0])).toEqual(["a", "b"]);
  expect(css).toContain("a { display: none !important; }");
});

test("today uses the local calendar day", () => {
  expect(today(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
});

test("buildQuestions asks two nouls per component by path", () => {
  const q = buildQuestions(2);
  expect(Object.keys(q)).toEqual(["c0_distracting", "c0_essential", "c1_distracting", "c1_essential"]);
  expect(q.c1_essential?.instructions).toContain("`components[1]`");
});
