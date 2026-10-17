/**
 * eras.ts — era/session tracker + issuance snapshots.
 */
import type { Rpc } from "./rpc.js";
import { storageKey, decU32, decU64, hexToBytes } from "./twox.js";

export interface EraState {
  currentEra: number | null;
  sessionIndex: number | null;
  activeEra: number | null;
  eraStartedMs: number | null;
  totalIssuance: bigint | null;
}

const KEYS = {
  currentEra: storageKey("Staking", "CurrentEra"),
  activeEra: storageKey("Staking", "ActiveEra"),
  sessionIndex: storageKey("Session", "CurrentIndex"),
  validators: storageKey("Session", "Validators"),
  issuance: storageKey("Balances", "TotalIssuance"),
  timestamp: storageKey("Timestamp", "Now"),
};

export async function readEraState(rpc: Rpc): Promise<EraState> {
  const [ce, ae, si, ti, ts] = await Promise.all([
    rpc.getStorage(KEYS.currentEra),
    rpc.getStorage(KEYS.activeEra),
    rpc.getStorage(KEYS.sessionIndex),
    rpc.getStorage(KEYS.issuance),
    rpc.getStorage(KEYS.timestamp),
  ]);
  let activeEra: number | null = null;
  let eraStartedMs: number | null = null;
  if (ae) {
    const b = hexToBytes(ae);
    if (b[0] === 1) {
      activeEra = decU32(b, 1);
      if (b.length > 13 && b[5] === 1) eraStartedMs = Number(decU64(b, 6));
    }
  }
  return {
    currentEra: ce ? decU32(hexToBytes(ce)) : null,
    activeEra,
    eraStartedMs,
    sessionIndex: si ? decU32(hexToBytes(si)) : null,
    totalIssuance: ti ? hexToBytes(ti).reduce((acc, byte, i) => acc | (BigInt(byte) << BigInt(8 * i)), 0n) : null,
  };
}

export async function readValidators(rpc: Rpc): Promise<string[]> {
  const { decVecAccountId } = await import("./twox.js");
  const raw = await rpc.getStorage(KEYS.validators);
  return raw ? decVecAccountId(raw) : [];
}

export async function readChainTime(rpc: Rpc): Promise<number | null> {
  const raw = await rpc.getStorage(KEYS.timestamp);
  return raw ? Number(decU64(hexToBytes(raw))) : null;
}
