/**
 * loop.ts — the autonomous alert loop: pure decision core.
 *
 * Closes the circuit that makes POT Watch more than a monitor:
 *   live chain state  →  evaluate on-chain subscriptions  →  recordFire (native)
 *                   →  AlertFired event + Discord/Telegram delivery
 *
 * Everything here is pure and unit-tested (watcher/test/loop.test.ts).
 * Network I/O lives in evm.ts (reads) and firer.ts (writes); persistence in
 * LoopState below.
 *
 * AlertRegistry ABI surface used (selectors verified against the deployed
 * contract at 0xeae1…429d; keccak256 first-4-bytes):
 *   nextId()            0x61b8ce8c
 *   getAlert(uint256)   0x85081886
 *   recordFire(uint256) 0x2cabcf78
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SEL = {
  nextId: "0x61b8ce8c",
  getAlert: "0x85081886",
  recordFire: "0x2cabcf78",
} as const;

export const KINDS = ["ValidatorUptime", "EraRotation", "SlashEvent", "LargeTransfer"] as const;
export const CHANNELS = ["Discord", "Telegram"] as const;

/** On-chain subscription record, ABI-decoded from getAlert(uint256). */
export interface ChainAlert {
  id: number;
  owner: string;        // 0x-prefixed 20-byte address
  kind: number;         // 0..3
  target: string;       // 0x-prefixed 32 bytes (zero = network-wide)
  threshold: bigint;    // bps for uptime, raw units for transfers
  channel: number;      // 0 Discord, 1 Telegram
  active: boolean;
  createdAt: number;
  lastFiredAt: number;
  fireCount: number;
}

/** Live chain context the loop evaluates against (built by index.ts). */
export interface LoopCtx {
  block: number;
  era: number | null;
  /** validator 0x-pubkey → uptime in basis points within the watcher window */
  uptimeBps: Record<string, number>;
  /** 0x targets observed slashed since the previous check */
  slashedTargets: string[];
  /** largest transfer seen since the previous check, raw units (14 dp) */
  maxTransferRaw: bigint;
}

/** Per-subscription loop memory (persisted across restarts). */
export interface LoopStateEntry {
  lastFiredBlock: number | null;
  lastFiredEra: number | null;
}

export interface FireRecord {
  id: number;
  kind: string;
  reason: string;
  txHash: string | null;   // null = dry run
  block: number;
  at: string;              // ISO
  dryRun: boolean;
}

const ZERO32 = "0x" + "00".repeat(32);

/** pad a uint256 argument to 32 bytes */
export function padUint(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, "0");
}

/** calldata for recordFire(uint256 id) */
export function encodeRecordFire(id: number): string {
  return SEL.recordFire + padUint(id);
}

/** calldata for getAlert(uint256 id) */
export function encodeGetAlert(id: number): string {
  return SEL.getAlert + padUint(id);
}

/**
 * ABI-decode the Alert struct returned by getAlert:
 * (address owner, Kind kind, bytes32 target, uint64 threshold,
 *  Channel channel, bool active, uint64 createdAt, uint64 lastFiredAt,
 *  uint32 fireCount) — nine 32-byte words, head-only (no dynamic types).
 */
export function decodeAlert(id: number, hex: string): ChainAlert {
  const body = hex.replace(/^0x/, "");
  if (body.length < 64 * 9) throw new Error(`getAlert return too short: ${body.length / 2}B`);
  const w = (i: number) => body.slice(i * 64, (i + 1) * 64);
  const num = (i: number) => BigInt("0x" + w(i));
  return {
    id,
    owner: "0x" + w(0).slice(24),
    kind: Number(num(1)),
    target: "0x" + w(2),
    threshold: num(3),
    channel: Number(num(4)),
    active: num(5) !== 0n,
    createdAt: Number(num(6)),
    lastFiredAt: Number(num(7)),
    fireCount: Number(num(8)),
  };
}

export interface EvalResult {
  fire: boolean;
  reason: string;
}

/**
 * Pure decision: should subscription `a` fire now?
 * Honours: activity flag, per-subscription local cooldown, and the kind's
 * condition. The contract additionally enforces one fire per block per alert
 * (Cooldown revert), so a local cooldown of ≥1 block is always safe.
 */
export function evaluateAlert(
  a: ChainAlert,
  ctx: LoopCtx,
  st: LoopStateEntry,
  cooldownBlocks: number
): EvalResult {
  if (!a.active) return { fire: false, reason: "inactive" };
  if (st.lastFiredBlock !== null && ctx.block - st.lastFiredBlock < cooldownBlocks) {
    return { fire: false, reason: "cooldown" };
  }
  const kindName = KINDS[a.kind] ?? `kind${a.kind}`;
  switch (a.kind) {
    case 0: { // ValidatorUptime — threshold in bps
      const bps = ctx.uptimeBps[a.target];
      if (bps === undefined) return { fire: false, reason: "no-uptime-data" };
      if (bps < Number(a.threshold)) {
        return {
          fire: true,
          reason: `${kindName}: uptime ${(bps / 100).toFixed(2)}% < ${(Number(a.threshold) / 100).toFixed(2)}%`,
        };
      }
      return { fire: false, reason: "uptime-ok" };
    }
    case 1: { // EraRotation — fire once per era
      if (ctx.era === null) return { fire: false, reason: "no-era-data" };
      if (st.lastFiredEra === null || st.lastFiredEra !== ctx.era) {
        return {
          fire: true,
          reason: `${kindName}: era ${st.lastFiredEra === null ? "baseline" : st.lastFiredEra} → ${ctx.era}`,
        };
      }
      return { fire: false, reason: "same-era" };
    }
    case 2: { // SlashEvent — target, or any validator when target is zero
      const hit =
        a.target === ZERO32
          ? ctx.slashedTargets[0]
          : ctx.slashedTargets.includes(a.target)
            ? a.target
            : undefined;
      if (hit) return { fire: true, reason: `${kindName}: slash observed on ${hit.slice(0, 10)}…` };
      return { fire: false, reason: "no-slash" };
    }
    case 3: { // LargeTransfer — raw units (14 dp)
      if (ctx.maxTransferRaw > a.threshold) {
        return {
          fire: true,
          reason: `${kindName}: transfer ${ctx.maxTransferRaw / 10n ** 14n} POT > ${a.threshold / 10n ** 14n} POT`,
        };
      }
      return { fire: false, reason: "transfer-below-threshold" };
    }
    default:
      return { fire: false, reason: `unknown-kind-${a.kind}` };
  }
}

/** Fresh per-subscription loop memory. */
export function emptyEntry(): LoopStateEntry {
  return { lastFiredBlock: null, lastFiredEra: null };
}

interface LoopFile {
  entries: Record<string, LoopStateEntry>;
  fires: FireRecord[];
}

/**
 * Durable loop memory: which block/era each subscription last fired at, plus
 * the append-only fire ledger (the off-chain twin of on-chain fireCount).
 */
export class LoopState {
  private data: LoopFile = { entries: {}, fires: [] };
  constructor(private path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        this.data = { entries: {}, fires: [] };
      }
    }
  }
  entry(id: number): LoopStateEntry {
    return (this.data.entries[id] ??= emptyEntry());
  }
  recordFire(rec: FireRecord, entry: LoopStateEntry, ctx: LoopCtx) {
    entry.lastFiredBlock = ctx.block;
    if (ctx.era !== null) entry.lastFiredEra = ctx.era;
    this.data.fires.push(rec);
    if (this.data.fires.length > 500) this.data.fires.splice(0, this.data.fires.length - 500);
    this.save();
  }
  get fires(): FireRecord[] {
    return this.data.fires;
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
  static at(dataDir: string): LoopState {
    return new LoopState(join(dataDir, "loop-state.json"));
  }
}
