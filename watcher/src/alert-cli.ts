/**
 * alert-cli.ts — manage on-chain alert subscriptions from the terminal.
 *
 *   POTWATCH_LOOP_MNEMONIC="…" npm run alert -- register 0 9000 0 [targetHex]
 *   POTWATCH_LOOP_MNEMONIC="…" npm run alert -- cancel 3
 *   npm run alert -- list
 *
 * Writes go through the native surface (~0.02 tPOT per register/cancel);
 * `list` reads through the EVM surface (free). The dashboard's alert wizard
 * prints exactly these commands for users who prefer the browser flow.
 */
import { readFileSync } from "node:fs";
import { EvmRpc, readSubscriptions } from "./evm.js";
import { encodeRegisterAlert, encodeCancelAlert, KINDS, CHANNELS } from "./loop.js";
import { submitFireNative } from "./firer.js";

interface Config {
  rpcUrl: string;
  testnetRpcUrl?: string | null;
  loop?: { evmRpcUrl: string; contract: string; mnemonicEnv?: string };
}

const config: Config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const loop = config.loop;
if (!loop) {
  console.error("config.json has no loop section");
  process.exit(1);
}
const wsUrl = config.testnetRpcUrl ?? config.rpcUrl;
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  const evm = new EvmRpc(loop.evmRpcUrl);
  const subs = await readSubscriptions(evm, loop.contract);
  if (!subs.length) console.log("no subscriptions on-chain");
  for (const s of subs) {
    console.log(
      `#${s.id} ${KINDS[s.kind] ?? s.kind} target=${s.target} threshold=${s.threshold} channel=${CHANNELS[s.channel] ?? s.channel} active=${s.active} fires=${s.fireCount}`
    );
  }
  process.exit(0);
}

if (cmd === "register" || cmd === "cancel") {
  const mnemonic = process.env[loop.mnemonicEnv ?? "POTWATCH_LOOP_MNEMONIC"];
  if (!mnemonic) {
    console.error(`export ${loop.mnemonicEnv ?? "POTWATCH_LOOP_MNEMONIC"} first (never commit it)`);
    process.exit(1);
  }
  let calldata: string;
  let label: string;
  if (cmd === "register") {
    const [kindS, thrS, chS, target] = args;
    const kind = Number(kindS);
    const channel = Number(chS);
    if (!(kind in KINDS) || !(channel in CHANNELS)) {
      console.error("usage: register <kind 0-3> <threshold> <channel 0|1> [targetHex32]");
      process.exit(1);
    }
    calldata = encodeRegisterAlert(kind, target ?? "0x" + "00".repeat(32), BigInt(thrS ?? 0), channel);
    label = `registerAlert(${KINDS[kind]}, thr=${thrS}, ${CHANNELS[channel]})`;
  } else {
    calldata = encodeCancelAlert(Number(args[0]));
    label = `cancelAlert(#${args[0]})`;
  }
  const out = await submitFireNative({ wsUrl, mnemonic, contract: loop.contract, calldata, label });
  console.log(`${out.success ? "✅" : "❌"} ${label} → tx ${out.txHash} block ${out.blockNumber}`);
  process.exit(out.success ? 0 : 1);
}

console.error("usage: npm run alert -- <list|register|cancel> …");
process.exit(1);
