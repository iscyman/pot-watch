/**
 * security.ts — the security analytics engine (Package 08).
 *
 * Four live signals, all read straight from chain storage through the
 * metadata walker (no backend, no indexer):
 *   1. stake concentration — per-validator active stake → Herfindahl index
 *   2. validator churn     — session-by-session set joins/leaves
 *   3. slash feed          — Staking/Balances slash events, block-stamped
 *   4. health history      — append-only score timeline for trend views
 *
 * Persisted to dataDir/security.json (snapshot) + security.jsonl (feed).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Rpc } from "./rpc.js";
import { findStakingLedger, type Decoder, type StorageItemMeta } from "./walker.js";
import type { SlashHit } from "./events.js";
import { ss58ToHex } from "./twox.js";

export interface StakeRow {
  address: string;      // ss58
  hex: string;          // 0x pubkey (matches on-chain alert targets)
  active: bigint;       // active stake, raw units
  sharePct: number;
}

export interface SecuritySnapshot {
  at: number;
  atBlock: number;
  stakeTotal: bigint;
  stakeHhi: number;             // 0..1 over active stake
  stakes: StakeRow[];
  churn: { session: number | null; joined: string[]; left: string[] } | null;
  slashCount: number;
  lastSlash: SlashHit | null;
}

export class SecurityMonitor {
  private stakes: StakeRow[] = [];
  private stakeTotal = 0n;
  private lastSessionSet: string[] | null = null;
  private lastChurn: SecuritySnapshot["churn"] = null;
  private slashes: SlashHit[] = [];

  constructor(private rpc: Rpc, private decoder: () => Decoder | null, private dataDir: string) {}

  /** Active stake per bonded account, read from Staking.Ledger map values. */
  async refreshStakes(validators: string[]): Promise<StakeRow[]> {
    const dec = this.decoder();
    if (!dec) return this.stakes;
    const ledgerItem: StorageItemMeta = { name: "Ledger", modifier: 0, kind: "map", type: findStakingLedger(dec.reg) };
    const prefix = storagePrefix("Staking", "Ledger");
    const keys: string[] = await this.rpc.call("state_getKeysPaged", [prefix, 100, prefix]);
    const rows: StakeRow[] = [];
    for (const key of keys) {
      const raw: string | null = await this.rpc.getStorage(key);
      if (!raw) continue;
      const ledger = dec.decodeStorage(ledgerItem, raw) as Record<string, any> | null;
      if (!ledger) continue;
      const stash = unwrapHex(ledger.stash) ?? "0x" + key.slice(-64);
      const active = BigInt(ledger.active ?? 0);
      rows.push({ address: stash, hex: stash, active, sharePct: 0 });
    }
    const total = rows.reduce((a, r) => a + r.active, 0n);
    for (const r of rows) r.sharePct = total ? Number((r.active * 10000n) / total) / 100 : 0;
    const byHex = new Map(validators.map((v) => [ss58ToHex(v), v]));
    for (const r of rows) if (byHex.has(r.hex)) r.address = byHex.get(r.hex)!;
    rows.sort((a, b) => (a.active > b.active ? -1 : 1));
    this.stakes = rows;
    this.stakeTotal = total;
    return rows;
  }

  stakeHhi(): number {
    if (!this.stakeTotal) return 0;
    return this.stakes.reduce((a, r) => a + (r.sharePct / 100) ** 2, 0);
  }

  /** Compare the active validator set against the previous session's. */
  noteValidatorSet(session: number | null, validators: string[]): { joined: string[]; left: string[] } {
    const prev = this.lastSessionSet;
    const joined = prev ? validators.filter((v) => !prev.includes(v)) : [];
    const left = prev ? prev.filter((v) => !validators.includes(v)) : [];
    this.lastSessionSet = [...validators];
    this.lastChurn = { session, joined, left };
    return { joined, left };
  }

  noteSlashes(hits: SlashHit[]) {
    if (!hits.length) return;
    this.slashes.push(...hits);
    if (this.slashes.length > 500) this.slashes.splice(0, this.slashes.length - 500);
    this.appendJsonl(hits.map((h) => ({ kind: "slash", ...h, amount: h.amount.toString() })));
  }

  snapshot(atBlock: number): SecuritySnapshot {
    const snap: SecuritySnapshot = {
      at: Date.now(),
      atBlock,
      stakeTotal: this.stakeTotal,
      stakeHhi: this.stakeHhi(),
      stakes: this.stakes,
      churn: this.lastChurn,
      slashCount: this.slashes.length,
      lastSlash: this.slashes[this.slashes.length - 1] ?? null,
    };
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(join(this.dataDir, "security.json"), JSON.stringify(snap, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return snap;
  }

  get slashFeed(): SlashHit[] {
    return this.slashes;
  }

  get rows(): StakeRow[] {
    return this.stakes;
  }

  /** Health-score timeline (appended by index.ts on every health refresh). */
  appendHealth(row: Record<string, unknown>) {
    this.appendJsonl([{ kind: "health", ...row }]);
  }

  private appendJsonl(rows: Record<string, unknown>[]) {
    mkdirSync(this.dataDir, { recursive: true });
    appendFileSync(
      join(this.dataDir, "security.jsonl"),
      rows.map((r) => JSON.stringify(r, (k, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n") + "\n"
    );
  }

  /** pure helper, unit-tested */
  static hhi(sharesPct: number[]): number {
    return sharesPct.reduce((a, s) => a + (s / 100) ** 2, 0);
  }
}

/** Newtype-safe hex extraction (AccountId32 may decode as string or [string]). */
function unwrapHex(v: any): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

// ---------- storage-key helpers (map keys) ----------
import { twox128 } from "./twox.js";
import { createHash } from "node:crypto";

function blake2_128(hexOrBytes: Uint8Array): string {
  return createHash("blake2b512").update(Buffer.from(hexOrBytes)).digest("hex").slice(0, 32);
}

export function storagePrefix(pallet: string, item: string): string {
  return "0x" + twox128(pallet) + twox128(item);
}

/** Staking.Ledger is keyed by blake2_128_concat(controller) */
function ledgerKey(controllerHex: string): string {
  const ctrl = Uint8Array.from(Buffer.from(controllerHex.replace(/^0x/, ""), "hex"));
  return "0x" + twox128("Staking") + twox128("Ledger") + blake2_128(ctrl) + controllerHex.replace(/^0x/, "");
}
