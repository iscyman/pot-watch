/**
 * blocks.ts — block ingestion: header decoding + BABE author extraction.
 */
import type { Rpc } from "./rpc.js";
import { hexToBytes, decU32, decU64, decCompact, abbreviate } from "./twox.js";

export interface HeaderInfo {
  number: number;
  hash: string;
  parent: string;
  extrinsics: number;
  authorIndex: number | null;
  slot: bigint | null;
}

/** Extract BABE PreRuntime digest → authority index + slot */
export function decodePreRuntime(logs: string[]): { authorIndex: number | null; slot: bigint | null } {
  for (const log of logs) {
    const b = hexToBytes(log);
    if (b.length < 10) continue;
    if (b[0] !== 0x06) continue; // DigestItem::PreRuntime
    const engine = Buffer.from(b.subarray(1, 5)).toString("ascii");
    if (engine !== "BABE") continue;
    const [, off] = decCompact(b, 5); // payload length
    const base = 5 + off;
    // payload: variant u8, authorityIndex u32, slot u64
    const variant = b[base];
    if (variant < 1 || variant > 3) continue;
    const authorIndex = decU32(b, base + 1);
    const slot = decU64(b, base + 5);
    return { authorIndex, slot };
  }
  return { authorIndex: null, slot: null };
}

export async function fetchBlock(rpc: Rpc, hash: string): Promise<HeaderInfo | null> {
  try {
    const block = await rpc.call<any>("chain_getBlock", [hash]);
    const header = block.block.header;
    const { authorIndex, slot } = decodePreRuntime(header.digest?.logs ?? []);
    return {
      number: parseInt(header.number, 16),
      hash: header.parentHash ? hash : hash,
      parent: header.parentHash,
      extrinsics: block.block.extrinsics?.length ?? 0,
      authorIndex,
      slot,
    };
  } catch {
    return null;
  }
}

export function blockLine(info: HeaderInfo, validators: string[], finalizedLag: number): string {
  const author = info.authorIndex !== null ? validators[info.authorIndex] : null;
  return `⛓ #${info.number.toLocaleString()} (${info.extrinsics} ext) by ${
    author ? abbreviate(author) : "?"
  } | fin-lag ${finalizedLag}`;
}
