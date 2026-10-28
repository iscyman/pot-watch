/**
 * loop.test.ts — the autonomous alert loop's pure decision core.
 * Vectors mirror the LIVE AlertRegistry at 0xeae1…429d (V3 testnet).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAlert,
  encodeRecordFire,
  encodeGetAlert,
  evaluateAlert,
  emptyEntry,
  LoopState,
  SEL,
  type ChainAlert,
  type LoopCtx,
} from "../src/loop.js";

const T = "0x" + "ab".repeat(32);
const w = (n: bigint | number) => n.toString(16).padStart(64, "0");

const alert = (over: Partial<ChainAlert> = {}): ChainAlert => ({
  id: 1,
  owner: "0x" + "11".repeat(20),
  kind: 0,
  target: T,
  threshold: 9000n,
  channel: 0,
  active: true,
  createdAt: 0,
  lastFiredAt: 0,
  fireCount: 0,
  ...over,
});

const ctx = (over: Partial<LoopCtx> = {}): LoopCtx => ({
  block: 1000,
  era: 41,
  uptimeBps: { [T]: 9500 },
  slashedTargets: [],
  maxTransferRaw: 0n,
  ...over,
});

test("selectors match the deployed contract", () => {
  assert.equal(SEL.nextId, "0x61b8ce8c");
  assert.equal(SEL.getAlert, "0x85081886");
  assert.equal(SEL.recordFire, "0x2cabcf78");
});

test("encodeRecordFire pads id to a uint256 word", () => {
  assert.equal(encodeRecordFire(2), SEL.recordFire + w(2));
  assert.equal(encodeRecordFire(1).length, 8 + 64 + 2);
});

test("encodeGetAlert pads id to a uint256 word", () => {
  assert.equal(encodeGetAlert(1), SEL.getAlert + w(1));
});

test("decodeAlert unpacks the 9-word Alert struct", () => {
  const hex =
    "0x" +
    [
      "0".repeat(24) + "11".repeat(20), // owner
      w(1),                             // kind = EraRotation
      "ab".repeat(32),                  // target
      w(9000),                          // threshold
      w(1),                             // channel = Telegram
      w(1),                             // active
      w(1730000000),                    // createdAt
      w(0),                             // lastFiredAt
      w(7),                             // fireCount
    ].join("");
  const a = decodeAlert(3, hex);
  assert.equal(a.id, 3);
  assert.equal(a.owner, "0x" + "11".repeat(20));
  assert.equal(a.kind, 1);
  assert.equal(a.target, T);
  assert.equal(a.threshold, 9000n);
  assert.equal(a.channel, 1);
  assert.equal(a.active, true);
  assert.equal(a.createdAt, 1730000000);
  assert.equal(a.fireCount, 7);
});

test("decodeAlert rejects short return data (revert/empty)", () => {
  assert.throws(() => decodeAlert(1, "0x1234"), /too short/);
});

test("uptime below threshold fires with a readable reason", () => {
  const r = evaluateAlert(alert(), ctx({ uptimeBps: { [T]: 8500 } }), emptyEntry(), 100);
  assert.equal(r.fire, true);
  assert.match(r.reason, /ValidatorUptime: uptime 85\.00% < 90\.00%/);
});

test("uptime at/above threshold does not fire", () => {
  assert.equal(evaluateAlert(alert(), ctx(), emptyEntry(), 100).fire, false);
});

test("missing uptime data never fires (fail-safe)", () => {
  const r = evaluateAlert(alert(), ctx({ uptimeBps: {} }), emptyEntry(), 100);
  assert.equal(r.fire, false);
  assert.equal(r.reason, "no-uptime-data");
});

test("era rotation fires once per era", () => {
  const a = alert({ kind: 1, target: "0x" + "00".repeat(32), threshold: 0n });
  const first = evaluateAlert(a, ctx(), emptyEntry(), 100);
  assert.equal(first.fire, true);
  assert.match(first.reason, /era baseline → 41/);
  const st = { lastFiredBlock: 800, lastFiredEra: 41 }; // outside cooldown
  assert.equal(evaluateAlert(a, ctx(), st, 100).reason, "same-era");
  assert.equal(evaluateAlert(a, ctx({ era: 42 }), st, 100).fire, true);
});

test("slash events fire for the watched target and for zero-target (network-wide)", () => {
  const targeted = alert({ kind: 2 });
  assert.equal(evaluateAlert(targeted, ctx({ slashedTargets: [T] }), emptyEntry(), 100).fire, true);
  assert.equal(evaluateAlert(targeted, ctx({ slashedTargets: ["0x" + "cd".repeat(32)] }), emptyEntry(), 100).fire, false);
  const networkWide = alert({ kind: 2, target: "0x" + "00".repeat(32) });
  assert.equal(evaluateAlert(networkWide, ctx({ slashedTargets: ["0x" + "cd".repeat(32)] }), emptyEntry(), 100).fire, true);
});

test("large transfers fire only above threshold (raw 14-dp units)", () => {
  const a = alert({ kind: 3, threshold: 1000n * 10n ** 14n }); // 1000 POT
  assert.equal(evaluateAlert(a, ctx({ maxTransferRaw: 999n * 10n ** 14n }), emptyEntry(), 100).fire, false);
  const hit = evaluateAlert(a, ctx({ maxTransferRaw: 1001n * 10n ** 14n }), emptyEntry(), 100);
  assert.equal(hit.fire, true);
  assert.match(hit.reason, /1001 POT > 1000 POT/);
});

test("local cooldown suppresses repeat fires", () => {
  const st = { lastFiredBlock: 999, lastFiredEra: 40 };
  const r = evaluateAlert(alert(), ctx({ uptimeBps: { [T]: 100 } }), st, 100);
  assert.equal(r.fire, false);
  assert.equal(r.reason, "cooldown");
});

test("cancelled (inactive) subscriptions never fire", () => {
  const r = evaluateAlert(alert({ active: false }), ctx({ uptimeBps: { [T]: 0 } }), emptyEntry(), 100);
  assert.equal(r.fire, false);
  assert.equal(r.reason, "inactive");
});

test("LoopState persists entries and the fire ledger across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "potwatch-loop-"));
  try {
    const s1 = LoopState.at(dir);
    const e = s1.entry(2);
    s1.recordFire(
      { id: 2, kind: "EraRotation", reason: "era 41 → 42", txHash: "0xdead", block: 1000, at: new Date().toISOString(), dryRun: false },
      e,
      ctx({ era: 42 })
    );
    const s2 = LoopState.at(dir); // reload from disk
    assert.equal(s2.entry(2).lastFiredBlock, 1000);
    assert.equal(s2.entry(2).lastFiredEra, 42);
    assert.equal(s2.fires.length, 1);
    assert.equal(s2.fires[0].txHash, "0xdead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
