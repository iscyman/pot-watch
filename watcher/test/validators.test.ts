/**
 * validators.test.ts — authorship accounting, availability, HHI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidatorStats } from "../src/validators.js";

const VS = ["5A…", "5B…"];

test("records authorship and counts blocks per validator", () => {
  const v = new ValidatorStats(90);
  v.record(1, 0, 2);
  v.record(2, 1, 2);
  v.record(3, 0, 2);
  const s = v.summarize(VS);
  assert.equal(s[0].blocks, 2);
  assert.equal(s[1].blocks, 1);
});

test("availability is the fraction of validators seen within the window", () => {
  const v = new ValidatorStats(90);
  v.record(1, 0, 2);
  v.record(2, 0, 2);
  assert.equal(v.availability(VS), 0.5);
  v.record(3, 1, 2);
  assert.equal(v.availability(VS), 1);
});

test("validator silent beyond the window is flagged inactive", () => {
  const v = new ValidatorStats(90);
  v.record(1, 0, 2);
  v.record(100, 0, 2);
  const s = v.summarize(VS);
  assert.equal(s[0].inactive, false);
  assert.equal(s[1].inactive, true);
  assert.equal(s[1].lastSeenAgo, null); // never seen
  assert.equal(s[0].lastSeenAgo, 0);
});

test("equal block shares give HHI 0.5 for two validators", () => {
  const v = new ValidatorStats(90);
  v.record(1, 0, 2);
  v.record(2, 1, 2);
  assert.equal(v.hhi(VS), 0.5);
});

test("single-author monopoly gives HHI 1", () => {
  const v = new ValidatorStats(90);
  v.record(1, 0, 2);
  v.record(2, 0, 2);
  assert.equal(v.hhi(VS), 1);
});

test("shares sum to 100% and ignore out-of-range authors", () => {
  const v = new ValidatorStats(90);
  v.record(1, 0, 2);
  v.record(2, 1, 2);
  v.record(3, 7, 2); // out of range → ignored
  const s = v.summarize(VS);
  assert.equal(s[0].sharePct + s[1].sharePct, 100);
});

test("SecurityMonitor.hhi: duopoly ≈ 0.5, monopoly = 1", async () => {
  const { SecurityMonitor } = await import("../src/security.js");
  assert.equal(SecurityMonitor.hhi([50, 50]), 0.5);
  assert.equal(SecurityMonitor.hhi([100]), 1);
  assert.ok(Math.abs(SecurityMonitor.hhi([49.93, 49.93, 0.07, 0.05, 0]) - 0.4986) < 0.001);
});

test("validator churn detects joins and leaves", async () => {
  const { SecurityMonitor } = await import("../src/security.js");
  const dir = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/churn-");
  const sec = new SecurityMonitor(null as any, () => null, dir);
  sec.noteValidatorSet(1, ["A", "B"]);
  const c = sec.noteValidatorSet(2, ["B", "C"]);
  assert.deepEqual(c.joined, ["C"]);
  assert.deepEqual(c.left, ["A"]);
  (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
});
