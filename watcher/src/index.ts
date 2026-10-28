/**
 * index.ts — POT Watch entry point.
 * Connects to a Portaldot node, streams blocks, tracks eras/sessions,
 * computes validator metrics + health score, evaluates alerts, persists everything.
 */
import { readFileSync } from "node:fs";
import { Rpc } from "./rpc.js";
import { Store } from "./store.js";
import { fetchBlock, blockLine } from "./blocks.js";
import { readEraState, readValidators } from "./eras.js";
import { ValidatorStats } from "./validators.js";
import { computeHealth } from "./health.js";
import { AlertEngine, type AlertRule } from "./alerts.js";
import { formatPot, ss58ToHex } from "./twox.js";
import { EvmRpc, readSubscriptions } from "./evm.js";
import { evaluateAlert, encodeRecordFire, LoopState, KINDS } from "./loop.js";
import { submitFireNative } from "./firer.js";

interface Config {
  rpcUrl: string;
  testnetRpcUrl?: string | null;
  dataDir: string;
  discordWebhook?: string | null;
  alerts?: AlertRule[];
  blockTimeTargetS?: number;
  loop?: {
    enabled: boolean;
    evmRpcUrl: string;
    contract: string;
    checkEveryBlocks?: number;
    cooldownBlocks?: number;
    /** true (default) = evaluate + log only; false = submit recordFire on-chain */
    dryRun?: boolean;
    mnemonicEnv?: string;
  };
}

const config: Config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));

// `npm start -- --testnet` → watch the official PortaldotV3 testnet
const useTestnet = process.argv.includes("--testnet");
const rpcUrl = useTestnet && config.testnetRpcUrl ? config.testnetRpcUrl : config.rpcUrl;

const rpc = new Rpc(rpcUrl);
const dataDir = useTestnet ? `${config.dataDir.replace(/\/$/, "")}-testnet` : config.dataDir;
const store = new Store(dataDir);
const vstats = new ValidatorStats();
const alerts = new AlertEngine(config.alerts ?? [], config.discordWebhook);

// ---- autonomous on-chain alert loop (Package 07) ----
const loopCfg = config.loop;
const evm = loopCfg?.enabled ? new EvmRpc(loopCfg.evmRpcUrl) : null;
const loopState = loopCfg?.enabled ? LoopState.at(dataDir) : null;
let loopMnemonicWarned = false;

let validators: string[] = [];
let era = { currentEra: null as number | null, sessionIndex: null as number | null };
let lastEra: number | null = null;
let lastEraBlock: number | null = null;
let latestBest = 0;
let latestFinalized = 0;
let blockTimes: number[] = [];
let lastHeadAt = Date.now();
let processed = 0;

async function pollChainState(blockNumber: number) {
  const state = await readEraState(rpc);
  const prevSession = era.sessionIndex;
  era = { currentEra: state.currentEra, sessionIndex: state.sessionIndex };

  if (state.currentEra !== null && state.currentEra !== lastEra) {
    const blocksInEra = lastEraBlock !== null ? blockNumber - lastEraBlock : undefined;
    store.appendEra({
      era: state.currentEra,
      session: state.sessionIndex ?? -1,
      atBlock: blockNumber,
      at: Date.now(),
      blocksInEra,
    });
    if (lastEra !== null) {
      await alerts.evaluate(blockNumber, [
        { rule: { kind: "era_rotation" }, message: `Era rotated: ${lastEra} → ${state.currentEra}${blocksInEra ? ` (${blocksInEra} blocks)` : ""}`, at: Date.now(), data: { from: lastEra, to: state.currentEra } },
      ]);
    }
    lastEra = state.currentEra;
    lastEraBlock = blockNumber;
  }
  if (state.totalIssuance !== null) {
    store.appendIssuance({
      era: state.currentEra ?? -1,
      atBlock: blockNumber,
      at: Date.now(),
      totalIssuance: state.totalIssuance.toString(),
    });
  }
  return { state, sessionChanged: prevSession !== null && prevSession !== state.sessionIndex };
}

function refreshHealth(blockNumber: number) {
  const avgBlockTime = blockTimes.length
    ? blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length / 1000
    : config.blockTimeTargetS ?? 6;
  const health = computeHealth({
    finalityLag: Math.max(0, latestBest - latestFinalized),
    availability: vstats.availability(validators),
    blockTimeAvgS: avgBlockTime,
    blockTimeTargetS: config.blockTimeTargetS ?? 6,
    hhi: vstats.hhi(validators),
    slashEvents30d: 0, // TODO Phase 4: scan Offences pallet events
  });
  store.saveHealth({ at: Date.now(), atBlock: blockNumber, ...health });
  return health;
}

/**
 * Autonomous on-chain alert loop: read our subscriptions from the
 * AlertRegistry (EVM surface, free), evaluate them against live chain state,
 * and record every fire back on-chain (native surface, ~0.015 tPOT) so each
 * alert leaves a verifiable, tamper-evident receipt.
 */
async function runLoopCheck(blockNumber: number) {
  if (!loopCfg?.enabled || !evm || !loopState) return;
  try {
    const subs = await readSubscriptions(evm, loopCfg.contract);
    if (!subs.length) return;

    // activity-based uptime in bps: observed block share vs fair share (1/n)
    const n = validators.length || 1;
    const uptimeBps: Record<string, number> = {};
    for (const s of vstats.summarize(validators)) {
      const fair = 1 / n;
      uptimeBps[ss58ToHex(s.address)] = s.inactive
        ? 0
        : Math.min(10000, Math.round((s.sharePct / 100 / fair) * 10000));
    }
    const ctx = {
      block: blockNumber,
      era: era.currentEra,
      uptimeBps,
      slashedTargets: [] as string[], // Package 08: Offences pallet scan
      maxTransferRaw: 0n,             // Package 08: transfer extrinsic scan
    };

    for (const sub of subs) {
      const st = loopState.entry(sub.id);
      const res = evaluateAlert(sub, ctx, st, loopCfg.cooldownBlocks ?? 100);
      if (!res.fire) continue;
      const kindName = KINDS[sub.kind] ?? `kind${sub.kind}`;
      const dry = loopCfg.dryRun !== false;
      const mnemonic = process.env[loopCfg.mnemonicEnv ?? "POTWATCH_LOOP_MNEMONIC"];

      if (dry || !mnemonic) {
        if (!dry && !loopMnemonicWarned) {
          loopMnemonicWarned = true;
          console.warn(`⚠️  loop: export ${loopCfg.mnemonicEnv ?? "POTWATCH_LOOP_MNEMONIC"} to fire on-chain (staying in dry-run)`);
        }
        loopState.recordFire(
          { id: sub.id, kind: kindName, reason: res.reason, txHash: null, block: blockNumber, at: new Date().toISOString(), dryRun: true },
          st, ctx
        );
        await alerts.notify(`LOOP ${kindName} #${sub.id}`, res.reason, { dryRun: true });
        continue;
      }

      try {
        const out = await submitFireNative({
          wsUrl: rpcUrl,
          mnemonic,
          contract: loopCfg.contract,
          calldata: encodeRecordFire(sub.id),
          label: `recordFire#${sub.id}`,
        });
        if (out.success) {
          loopState.recordFire(
            { id: sub.id, kind: kindName, reason: res.reason, txHash: out.txHash, block: out.blockNumber, at: new Date().toISOString(), dryRun: false },
            st, ctx
          );
          await alerts.notify(`LOOP ${kindName} #${sub.id} → on-chain`, res.reason, { txHash: out.txHash });
          console.log(`️  loop fired alert #${sub.id} at block ${out.blockNumber} — tx ${out.txHash}`);
        } else {
          console.warn(`loop: recordFire #${sub.id} extrinsic failed:`, out.events.join(","));
        }
      } catch (e) {
        console.warn(`loop: fire #${sub.id} failed:`, (e as Error).message);
      }
    }
  } catch (e) {
    console.warn("loop check failed:", (e as Error).message);
  }
}

async function main() {
  console.log(`POT Watch watcher v0.1.0 — connecting to ${rpcUrl}${useTestnet ? " (TESTNET)" : ""}`);
  await rpc.connect();
  validators = await readValidators(rpc);
  console.log(`✓ connected — ${validators.length} validators in active set`);

  // baseline finality so lag starts at a real value
  const finHead = await rpc.call<string>("chain_getFinalizedHead");
  const finHeader = await rpc.call<any>("chain_getHeader", [finHead]);
  latestFinalized = parseInt(finHeader.number, 16);
  latestBest = latestFinalized;

  const init = await pollChainState(0);
  console.log(`✓ era ${era.currentEra}, session ${era.sessionIndex}, supply ${
    init.state.totalIssuance !== null ? formatPot(init.state.totalIssuance) + " POT" : "?"}`);

  await rpc.subscribe("chain_subscribeFinalizedHeads", [], (header: any) => {
    latestFinalized = parseInt(header.number, 16);
  });

  await rpc.subscribe("chain_subscribeNewHeads", [], async (header: any) => {
    const number = parseInt(header.number, 16);
    if (number <= latestBest) return; // skip forks/reorg replays
    latestBest = number;

    const now = Date.now();
    blockTimes.push(now - lastHeadAt);
    if (blockTimes.length > 20) blockTimes.shift();
    lastHeadAt = now;

    const hash = await rpc.call<string>("chain_getBlockHash", [number]);
    const info = await fetchBlock(rpc, hash);
    const authorIndex = info?.authorIndex ?? null;
    const author = authorIndex !== null ? validators[authorIndex] : null;

    vstats.record(number, authorIndex, validators.length);
    processed++;

    store.appendBlock({
      number,
      hash,
      parent: info?.parent ?? "",
      ts: now,
      extrinsics: info?.extrinsics ?? 0,
      authorIndex,
      author,
      finalized: number <= latestFinalized,
    });

    console.log(blockLine(
      { number, hash, parent: info?.parent ?? "", extrinsics: info?.extrinsics ?? 0, authorIndex, slot: info?.slot ?? null },
      validators,
      Math.max(0, latestBest - latestFinalized)
    ));

    if (processed % 5 === 0) {
      await pollChainState(number);
      store.saveValidatorStats(vstats.summarize(validators));
    }
    if (loopCfg?.enabled && processed % (loopCfg.checkEveryBlocks ?? 5) === 0) {
      await runLoopCheck(number);
    }
    if (processed % 30 === 0) {
      const health = refreshHealth(number);
      store.saveState({ validators, era, latestBest, latestFinalized, processed, at: now });
      console.log(`💓 health ${health.score}/100 (${health.grade}) | era ${era.currentEra} | sess ${era.sessionIndex} | blocks watched: ${processed}`);
      const inactive = vstats.summarize(validators).filter((s) => s.inactive);
      if (inactive.length) {
        await alerts.evaluate(number, inactive.map((s) => ({
          rule: { kind: "validator_inactive" as const, window: vstats.windowBlocks },
          message: `Validator ${s.address.slice(0, 6)}…${s.address.slice(-4)} inactive for ${s.lastSeenAgo}+ blocks`,
          at: Date.now(),
          data: { address: s.address },
        })));
      }
    }
  });

  const shutdown = () => {
    console.log("\nshutting down — saving state…");
    store.saveState({ validators, era, latestBest, latestFinalized, processed, at: Date.now() });
    store.saveValidatorStats(vstats.summarize(validators));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
