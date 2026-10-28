/**
 * evm.ts — minimal EVM JSON-RPC reader for the AlertRegistry (HTTP surface).
 *
 * The autonomous loop reads its own on-chain subscriptions through the EVM
 * surface (eth_call — free, no signing) and writes fire receipts through the
 * native surface (see firer.ts — ~0.015 tPOT per recordFire).
 *
 * Retry-hardened the same way as the dashboard: content-type guard + jittered
 * backoff, because bursts through the public RPC can return HTML error pages.
 */
import { decodeAlert, encodeGetAlert, SEL, type ChainAlert } from "./loop.js";

export interface EvmCallResult {
  ok: boolean;
  hex: string;          // raw return data ("0x" on revert/empty)
  error?: string;
}

export class EvmRpc {
  constructor(public url: string, public retries = 4) {}

  private async raw(method: string, params: unknown[]): Promise<any> {
    let lastErr = "unreachable";
    for (let i = 0; i < this.retries; i++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        });
        const ctype = res.headers.get("content-type") ?? "";
        const text = await res.text();
        if (!ctype.includes("json")) {
          lastErr = `non-JSON response (${res.status})`;
          await this.backoff(i);
          continue;
        }
        const j = JSON.parse(text);
        if (j.error) {
          lastErr = typeof j.error === "string" ? j.error : j.error.message;
          await this.backoff(i);
          continue;
        }
        return j.result;
      } catch (e) {
        lastErr = (e as Error).message;
        await this.backoff(i);
      }
    }
    throw new Error(`EVM RPC ${method} failed after ${this.retries} tries: ${lastErr}`);
  }

  private backoff(i: number) {
    return new Promise((r) => setTimeout(r, 800 * 2 ** i + Math.random() * 400));
  }

  async blockNumber(): Promise<number> {
    const hex = await this.raw("eth_blockNumber", []);
    return parseInt(hex, 16);
  }

  /** eth_call to a contract; returns raw return data. Reverts surface as ok:false. */
  async call(to: string, data: string): Promise<EvmCallResult> {
    try {
      const hex = await this.raw("eth_call", [{ to, data }, "latest"]);
      return { ok: !!hex && hex !== "0x", hex: hex ?? "0x" };
    } catch (e) {
      return { ok: false, hex: "0x", error: (e as Error).message };
    }
  }
}

/** Read every live subscription (ids 1..nextId-1) from the AlertRegistry. */
export async function readSubscriptions(evm: EvmRpc, contract: string): Promise<ChainAlert[]> {
  const n = await evm.call(contract, SEL.nextId);
  if (!n.ok) return [];
  const nextId = Number(BigInt(n.hex));
  const out: ChainAlert[] = [];
  for (let id = 1; id < nextId; id++) {
    const r = await evm.call(contract, encodeGetAlert(id));
    if (r.ok) {
      try {
        out.push(decodeAlert(id, r.hex));
      } catch {
        /* skip undecodable id */
      }
    }
  }
  return out;
}
