/**
 * twox.test.ts — Substrate primitives: hashing, SCALE, ss58, formatting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { twox128, storageKey, decCompact, decU32, decU64, hexToBytes, formatPot, ss58, ss58ToHex } from "../src/twox.js";

test("twox128('System') matches Substrate ground truth", () => {
  assert.equal(twox128("System"), "26aa394eea5630e07c48ae0c9558cef7");
});

test("twox128('Balances') matches Substrate ground truth", () => {
  assert.equal(twox128("Balances"), "c2261276cc9d1f8598ea4b6a74b15c2f");
});

test("twox128('Staking') matches Substrate ground truth", () => {
  assert.equal(twox128("Staking"), "5f3e4907f716ac89b6347d15ececedca");
});

test("storageKey('Balances','TotalIssuance') matches ground truth", () => {
  assert.equal(
    storageKey("Balances", "TotalIssuance"),
    "0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80"
  );
});

test("decCompact single-byte mode (0x28 = 10)", () => {
  const [v, off] = decCompact(hexToBytes("0x28"));
  assert.equal(v, 10n);
  assert.equal(off, 1);
});

test("decCompact two-byte mode (0x2902 = 138)", () => {
  const [v, off] = decCompact(hexToBytes("0x2902"));
  assert.equal(v, 138n);
  assert.equal(off, 2);
});

test("decU32 little-endian (0x2c0f0000 = 3884)", () => {
  assert.equal(decU32(hexToBytes("0x2c0f0000")), 3884);
});

test("decU64 little-endian 64-bit", () => {
  assert.equal(decU64(hexToBytes("0x0100000000000000")), 1n);
  assert.equal(decU64(hexToBytes("0x00e8764817000000")), 100_000_000_000n);
});

test("formatPot uses 14-decimal native units", () => {
  assert.equal(formatPot(150_000_000_000_000n), "1.50");
  assert.equal(formatPot(360_000_000_000n), "0.00");
  assert.equal(formatPot(289n * 10n ** 14n), "289.00");
});

test("ss58(zero pubkey) matches known address", () => {
  assert.equal(ss58(new Uint8Array(32), 42), "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM");
  assert.equal(ss58ToHex("5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM"), "0x" + "00".repeat(32));
});

test("ss58 → ss58ToHex round-trips a 32-byte pubkey", () => {
  const pub = new Uint8Array(32);
  for (let i = 0; i < 32; i++) pub[i] = (i * 7 + 3) & 0xff;
  const addr = ss58(pub, 42);
  assert.equal(ss58ToHex(addr), "0x" + Buffer.from(pub).toString("hex"));
});

test("ss58ToHex rejects garbage", () => {
  assert.throws(() => ss58ToHex("0xnotbase58"), /bad base58|too short/);
});
