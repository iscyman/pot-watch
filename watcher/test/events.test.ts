/**
 * events.test.ts — security-relevant event extraction (pure filters).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSlashes, extractTransfers, extractNewSession, type NamedEvent } from "../src/events.js";

const A = "0x" + "aa".repeat(32);
const B = "0x" + "bb".repeat(32);

const ev = (pallet: string, name: string, fields: Record<string, any>): NamedEvent => ({
  pallet,
  name,
  fields,
  extrinsicIndex: 1,
});

test("Staking.Slashed and Balances.Slashed both feed the slash list", () => {
  const hits = extractSlashes(
    [
      ev("Staking", "Slashed", { staker: A, amount: 5n * 10n ** 14n }),
      ev("Balances", "Slashed", { who: B, amount: 1n }),
      ev("System", "ExtrinsicSuccess", {}),
    ],
    77
  );
  assert.equal(hits.length, 2);
  assert.equal(hits[0].who, A);
  assert.equal(hits[0].source, "Staking.Slashed");
  assert.equal(hits[1].source, "Balances.Slashed");
  assert.equal(hits[0].block, 77);
});

test("SlashReported counts as a slash signal with zero amount", () => {
  const hits = extractSlashes([ev("Staking", "SlashReported", { validator: A, fraction: 1, slash_era: 41 })], 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].amount, 0n);
});

test("transfers extracted with raw 14-dp amounts", () => {
  const tr = extractTransfers([ev("Balances", "Transfer", { from: A, to: B, amount: 250n * 10n ** 14n })]);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].amount / 10n ** 14n, 250n);
});

test("NewSession yields the session index", () => {
  assert.equal(extractNewSession([ev("Session", "NewSession", { session_index: 347 })]), 347);
  assert.equal(extractNewSession([ev("System", "ExtrinsicSuccess", {})]), null);
});
