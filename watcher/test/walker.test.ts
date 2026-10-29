/**
 * walker.test.ts — metadata walker: cursor primitives, generic decoding,
 * newtype unwrapping, shape discovery. Registries here are hand-built so the
 * tests need no network; live-chain validation runs in CI-less smoke form
 * (see watcher README "verified live" notes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cur, Decoder, findAccountId32, findEventRecord, findStakingLedger, type Registry } from "../src/walker.js";

// ---- hand-built registry ----
// 0 u8 | 1 u128 | 2 [u8;32] | 3 AccountId32 newtype | 4 SlashedEnum variant
// 5 compact<u128> | 6 EventRecord composite | 7 sequence<6> | 8 str
const reg: Registry = {
  version: 14,
  types: [
    { path: [], def: { kind: "primitive", prim: "u8" } },
    { path: [], def: { kind: "primitive", prim: "u128" } },
    { path: [], def: { kind: "array", len: 32, type: 0 } },
    { path: ["sp_core", "crypto", "AccountId32"], def: { kind: "composite", fields: [{ name: null, type: 2 }] } },
    {
      path: ["pallet_staking", "pallet", "Event"],
      def: {
        kind: "variant",
        variants: [
          { name: "Slashed", index: 2, fields: [{ name: "staker", type: 3 }, { name: "amount", type: 1 }] },
          { name: "Bonded", index: 6, fields: [{ name: "stash", type: 3 }, { name: "amount", type: 1 }] },
        ],
      },
    },
    { path: [], def: { kind: "compact", type: 1 } },
    {
      path: ["EventRecord"],
      def: {
        kind: "composite",
        fields: [
          { name: "phase", type: 0 },
          { name: "event", type: 4 },
          { name: "topics", type: 7 },
        ],
      },
    },
    { path: [], def: { kind: "sequence", type: 6 } },
    { path: [], def: { kind: "primitive", prim: "str" } },
    {
      path: ["pallet_staking", "StakingLedger"],
      def: {
        kind: "composite",
        fields: [
          { name: "stash", type: 3 },
          { name: "total", type: 5 },
          { name: "active", type: 5 },
        ],
      },
    },
  ],
};
const dec = new Decoder(reg);
const cur = (hex: string) => new Cur(Uint8Array.from(Buffer.from(hex, "hex")));

test("cursor reads LE integers", () => {
  const c = cur("0100000000000000ff");
  assert.equal(c.u64(), 1n);
  assert.equal(c.u8(), 255);
});

test("u128 little-endian", () => {
  assert.equal(dec.decode(1, cur("00e87648170000000000000000000000")), 100_000_000_000n);
});

test("[u8;32] decodes to hex", () => {
  assert.equal(dec.decode(2, cur("ab".repeat(32))), "0x" + "ab".repeat(32));
});

test("AccountId32 newtype unwraps transparently", () => {
  assert.equal(dec.decode(3, cur("cd".repeat(32))), "0x" + "cd".repeat(32));
  assert.equal(findAccountId32(reg), 3);
});

test("variant decodes by tag with named fields", () => {
  const v = dec.decode(4, cur("02" + "11".repeat(32) + "39050000000000000000000000000000")) as any;
  assert.equal(v._variant, "Slashed");
  assert.equal(v.staker, "0x" + "11".repeat(32));
  assert.equal(v.amount, 1337n);
});

test("compact<u128> big-integer mode (1e11)", () => {
  // 100_000_000_000 = 0x174876e800 (5 bytes) → mode 3: (5-4)<<2|3 = 0x07 + LE bytes
  assert.equal(dec.decode(5, cur("0700e8764817")), 100_000_000_000n);
});

test("str primitive", () => {
  assert.equal(dec.decode(8, cur("1468656c6c6f")), "hello");
});

test("shape discovery finds EventRecord and StakingLedger", () => {
  assert.equal(findEventRecord(reg), 6);
  assert.equal(findStakingLedger(reg), 9);
});

test("decodeStorage honours Optional modifier (missing value → null)", () => {
  const item = { name: "Ledger", modifier: 0, kind: "map" as const, type: 9 };
  assert.equal(dec.decodeStorage(item, null), null);
});

test("ledger-shaped composite decodes named fields", () => {
  const hex = "11".repeat(32) + "a50f" + "9101"; // stash, compact total=1001, active=100
  const v = dec.decode(9, cur(hex)) as any;
  assert.equal(v.stash, "0x" + "11".repeat(32));
  assert.equal(v.total, 1001n); // compact<u128> stays bigint
  assert.equal(v.active, 100n);
});
