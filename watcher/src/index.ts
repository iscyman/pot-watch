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
import { formatPot } from "./twox.js";

interface Config {
  rpcUrl: string;
  testnetRpcUrl?: string | null;
  dataDir: string;
  discordWebhook?: string | null;
  alerts?: AlertRule[];
  blockTimeTargetS?: number;
}

const config: Config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));

// `npm start -- --testnet` → watch the official PortaldotV3 testnet
const useTestnet = process.argv.includes("--testnet");
const rpcUrl = useTestnet && config.testnetRpcUrl ? config.testnetRpcUrl : config.rpcUrl;

const rpc = new Rpc(rpcUrl);
const store = new Store(useTestnet ? `${config.dataDir.replace(/\/$/, "")}-testnet` : config.dataDir);
const vstats = new ValidatorStats();
const alerts = new AlertEngine(config.alerts ?? [], config.discordWebhook);

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
