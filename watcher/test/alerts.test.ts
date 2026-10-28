/**
 * alerts.test.ts — delivery engine: cooldown dedupe, disabled rules, notify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertEngine, type AlertEvent } from "../src/alerts.js";

async function withCapturedLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

const evt = (at = Date.now()): AlertEvent => ({
  rule: { kind: "era_rotation" },
  message: "Era rotated: 41 → 42",
  at,
  data: { from: 41, to: 42 },
});

test("identical alerts inside the cooldown window deliver once", async () => {
  const engine = new AlertEngine([{ kind: "era_rotation" }], null, 10);
  const lines = await withCapturedLog(async () => {
    await engine.evaluate(100, [evt()]);
    await engine.evaluate(105, [evt()]); // 5 blocks later — inside cooldown
  });
  assert.equal(lines.filter((l) => l.includes("ALERT")).length, 1);
});

test("alerts redeliver after the cooldown window passes", async () => {
  const engine = new AlertEngine([{ kind: "era_rotation" }], null, 10);
  const lines = await withCapturedLog(async () => {
    await engine.evaluate(100, [evt()]);
    await engine.evaluate(111, [evt()]); // 11 blocks later — cooldown elapsed
  });
  assert.equal(lines.filter((l) => l.includes("ALERT")).length, 2);
});

test("disabled rules are skipped", async () => {
  const engine = new AlertEngine([{ kind: "era_rotation", enabled: false }], null, 10);
  const lines = await withCapturedLog(async () => {
    await engine.evaluate(100, [evt()]);
  });
  assert.equal(lines.filter((l) => l.includes("ALERT")).length, 0);
});

test("notify() resolves without a webhook and logs the receipt", async () => {
  const engine = new AlertEngine([], null);
  const lines = await withCapturedLog(async () => {
    await engine.notify("LOOP EraRotation #2", "era 41 → 42", { txHash: "0xabc" });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /0xabc/);
});
