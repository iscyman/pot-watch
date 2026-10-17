/**
 * rpc.ts — minimal Substrate JSON-RPC client over WebSocket (method calls + subscriptions).
 */
import WebSocket from "ws";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Rpc {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subs = new Map<string, (result: any) => void>();
  public connected = false;

  constructor(public url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timeout = setTimeout(() => reject(new Error("RPC connect timeout")), 15000);
      ws.on("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });
      ws.on("error", (err) => {
        this.connected = false;
        if (!this.pending.size) return;
        reject(err);
      });
      ws.on("close", () => {
        this.connected = false;
      });
      ws.on("message", (raw) => this.onMessage(raw.toString()));
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? "rpc error"}`));
      else p.resolve(msg.result);
      return;
    }
    // Substrate notifications: {"method":"chain_newHead","params":{"subscription":id,"result":…}}
    if (msg.method && msg.params?.subscription !== undefined) {
      const cb = this.subs.get(String(msg.params.subscription));
      if (cb) cb(msg.params.result);
    }
  }

  call<T = any>(method: string, params: any[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) return reject(new Error("RPC not connected"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, jsonrpc: "2.0", method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 15000);
    });
  }

  async subscribe(method: string, params: any[], cb: (result: any) => void): Promise<string> {
    const subId = await this.call<string>(method, params);
    this.subs.set(String(subId), cb);
    return subId;
  }

  async getStorage(key: string): Promise<string | null> {
    return this.call<string | null>("state_getStorage", [key]);
  }

  close() {
    this.connected = false;
    this.ws?.close();
  }
}
