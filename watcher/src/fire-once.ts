/**
 * fire-once.ts — fire ONE on-chain alert receipt by hand.
 *
 * Uses: (a) proving the loop mechanism end-to-end before leaving the watcher
 * running unattended, (b) a deterministic demo moment for videos,
 * (c) topping up the on-chain fire ledger.
 *
 *   POTWATCH_LOOP_MNEMONIC="…" npm run fire -- 2          # fire alert #2
 *   npm run fire -- 2 --dry                               # evaluate only
 *
 * Cost: ~0.015 tPOT per fire on the native surface.
 */
import { readFileSync } from "node:fs";
import { EvmRpc, readSubscriptions } from "./evm.js";
import { encodeRecordFire, KINDS } from "./loop.js";
import { submitFireNative } from "./firer.js";

interface Config {
  rpcUrl: string;
  testnetRpcUrl?: string | null;
  loop?: {
    enabled?: boolean;
    evmRpcUrl: string;
    contract: string;
    mnemonicEnv?: string;
  };
}

const config: Config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const idArg = args.find((a) => /^\d+$/.test(a));
if (!idArg) {
  console.error("usage: npm run fire -- <alertId> [--dry]");
  process.exit(1);
}
const id = Number(idArg);
const loop = config.loop;
if (!loop) {
  console.error("config.json has no loop section");
  process.exit(1);
}

const wsUrl = config.testnetRpcUrl ?? config.rpcUrl; // the registry lives on V3 testnet

const evm = new EvmRpc(loop.evmRpcUrl);
const subs = await readSubscriptions(evm, loop.contract);
const sub = subs.find((s) => s.id === id);
if (!sub) {
  console.error(`alert #${id} not found on-chain. Live ids:`, subs.map((s) => s.id).join(", ") || "(none)");
  process.exit(1);
}
console.log(
  `alert #${id}: kind=${KINDS[sub.kind]} target=${sub.target.slice(0, 10)}… threshold=${sub.threshold} channel=${sub.channel} active=${sub.active} fires=${sub.fireCount}`
);
if (!sub.active) {
  console.error("alert is cancelled/inactive on-chain — recordFire would revert NotActive");
  process.exit(1);
}
if (dry) {
  console.log("dry run — no transaction sent.");
  process.exit(0);
}

const envName = loop.mnemonicEnv ?? "POTWATCH_LOOP_MNEMONIC";
const mnemonic = process.env[envName];
if (!mnemonic) {
  console.error(`export ${envName}="<loop wallet seed phrase>" first (never commit it)`);
  process.exit(1);
}

const out = await submitFireNative({
  wsUrl,
  mnemonic,
  contract: loop.contract,
  calldata: encodeRecordFire(id),
  label: `recordFire#${id}`,
});
console.log(
  `${out.success ? "✅" : "❌"} recordFire(#${id}) tx ${out.txHash} block ${out.blockNumber} events: ${out.events.join(", ")}`
);
process.exit(out.success ? 0 : 1);
