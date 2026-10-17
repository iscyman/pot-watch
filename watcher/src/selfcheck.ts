/**
 * selfcheck.ts — verify Substrate primitives against known ground-truth values.
 * Run: npm run selfcheck
 */
import { twox128, storageKey, ss58, decCompact, hexToBytes, decU32 } from "./twox.js";

let failed = 0;
function check(name: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`   got:  ${got}\n   want: ${want}`);
}

// Ground-truth pallet prefixes (same on every standard Substrate chain):
check("twox128('System')", twox128("System"), "26aa394eea5630e07c48ae0c9558cef7");
check("twox128('Balances')", twox128("Balances"), "c2261276cc9d1f8598ea4b6a74b15c2f");
check("twox128('Staking')", twox128("Staking"), "5f3e4907f716ac89b6347d15ececedca");
check(
  "storageKey('Balances','TotalIssuance')",
  storageKey("Balances", "TotalIssuance"),
  "0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80"
);

// SCALE compact: single-byte mode (0x28 → 10) and two-byte mode (0x29 0x02 → 138)
const [v1, o1] = decCompact(hexToBytes("0x28aabbcc"), 0);
check("decCompact single-byte (0x28) = 10", v1.toString(), "10");
check("decCompact consumed 1 byte", o1.toString(), "1");
const [v2] = decCompact(hexToBytes("0x2902"), 0);
check("decCompact two-byte (0x2902) = 138", v2.toString(), "138");

// u32 little-endian
check("decU32 LE (0x2c0f0000 = 3884)", decU32(hexToBytes("0x2c0f0000")).toString(), "3884");

// ss58: well-known address of the all-zero public key (prefix 42)
check(
  "ss58(zero pubkey)",
  ss58(new Uint8Array(32), 42),
  "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM"
);

console.log(failed === 0 ? "\nAll primitives verified ✅" : `\n${failed} check(s) failed ❌`);
process.exit(failed ? 1 : 0);
