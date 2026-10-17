/**
 * store.ts — append-only JSONL persistence + JSON state snapshot.
 * Phase 1 keeps it dependency-free; SQLite migration lands with the dashboard API.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BlockRow {
  number: number;
  hash: string;
  parent: string;
  ts: number;          // local receipt time (ms)
  extrinsics: number;
  authorIndex: number | null;
  author: string | null;
  finalized: boolean;
}

export interface EraRow {
  era: number;
  session: number;
  atBlock: number;
  at: number;          // ms epoch
  blocksInEra?: number; // filled on next rotation
}

export interface IssuanceRow {
  era: number;
  atBlock: number;
  at: number;
  totalIssuance: string; // raw u128 as string (14 decimals)
}

export class Store {
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private file(name: string) { return join(this.dir, name); }

  appendBlock(row: BlockRow) {
    appendFileSync(this.file("blocks.jsonl"), JSON.stringify(row) + "\n");
  }
  appendEra(row: EraRow) {
    appendFileSync(this.file("eras.jsonl"), JSON.stringify(row) + "\n");
  }
  appendIssuance(row: IssuanceRow) {
    appendFileSync(this.file("issuance.jsonl"), JSON.stringify(row) + "\n");
  }
  saveValidatorStats(stats: unknown) {
    writeFileSync(this.file("validator-stats.json"), JSON.stringify(stats, null, 2));
  }
  saveHealth(health: unknown) {
    writeFileSync(this.file("health.json"), JSON.stringify(health, null, 2));
  }
  saveState(state: unknown) {
    writeFileSync(this.file("state.json"), JSON.stringify(state, null, 2));
  }
  loadState<T = any>(): T | null {
    const f = this.file("state.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  }
}
