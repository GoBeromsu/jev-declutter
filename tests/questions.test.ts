import { expect, test } from "bun:test";
import { ProviderError, QUESTION_VERSION, RUBRIC, questionsFor } from "../src/providers/common";

test("question version is pinned", () => {
  expect(QUESTION_VERSION).toBe(1);
});

test("two items produce four questions in order", () => {
  const q = questionsFor(2);
  expect(q.map((x) => x.name)).toEqual(["i0_ad", "i0_suggested", "i1_ad", "i1_suggested"]);
  expect(q[0]?.instructions).toContain("`items[0]`");
  expect(q[1]?.instructions).toContain("`items[0]`");
  expect(q[3]?.instructions).toContain("`items[1]`");
});

test("zero items produce no questions", () => {
  expect(questionsFor(0)).toEqual([]);
});

test("rubric is a non-empty string", () => {
  expect(typeof RUBRIC).toBe("string");
  expect(RUBRIC.trim().length).toBeGreaterThan(0);
});

test("ProviderError carries its status", () => {
  const e = new ProviderError(429, "slow down");
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(429);
  expect(e.message).toContain("429");
});
