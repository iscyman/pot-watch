/**
 * health.test.ts — composite health score math & grading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHealth } from "../src/health.js";

const perfect = {
  finalityLag: 0,
  availability: 1,
  blockTimeAvgS: 6,
  blockTimeTargetS: 6,
  hhi: 0,
  slashEvents30d: 0,
};

test("perfect network scores 100 / EXCELLENT", () => {
  const h = computeHealth(perfect);
  assert.equal(h.score, 100);
  assert.equal(h.grade, "EXCELLENT");
});

test("finality lag costs 15 points per block (weight 25%)", () => {
  const h = computeHealth({ ...perfect, finalityLag: 2 });
  assert.equal(h.components.finality.score, 70);
  assert.equal(h.score, 93); // 70*.25 + 100*.75 = 92.5 → 93
});

test("half the validator set silent costs availability (weight 30%)", () => {
  const h = computeHealth({ ...perfect, availability: 0.5 });
  assert.equal(h.components.availability.score, 50);
  assert.equal(h.score, 85);
  assert.equal(h.grade, "GOOD");
});

test("grade boundaries: 60 = FAIR", () => {
  const h = computeHealth({
    finalityLag: 6,
    availability: 0.6,
    blockTimeAvgS: 6,
    blockTimeTargetS: 6,
    hhi: 0.5,
    slashEvents30d: 0,
  });
  assert.equal(h.score, 60);
  assert.equal(h.grade, "FAIR");
});

test("monopoly block production zeroes the decentralization component", () => {
  const h = computeHealth({ ...perfect, hhi: 1 });
  assert.equal(h.components.decentralization.score, 0);
});

test("four slash events zero the security component", () => {
  const h = computeHealth({ ...perfect, slashEvents30d: 4 });
  assert.equal(h.components.security.score, 0);
});

test("component scores clamp at 100 (hhi 0 would give 130)", () => {
  const h = computeHealth(perfect);
  assert.equal(h.components.decentralization.score, 100);
});
