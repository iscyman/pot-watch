/**
 * alerts.ts — alert evaluator: in-process rules now, on-chain AlertRegistry in Phase 3.
 * Delivery: console + optional Discord webhook (Telegram bot lands with Phase 3).
 */
export interface AlertRule {
  kind: "era_rotation" | "validator_inactive" | "finality_lag";
  window?: number;        // blocks, for validator_inactive
  threshold?: number;     // blocks, for finality_lag
  enabled?: boolean;
}

export interface AlertEvent {
  rule: AlertRule;
  message: string;
  at: number;
  data?: Record<string, unknown>;
}

export class AlertEngine {
  private firedRecently = new Map<string, number>();
  constructor(private rules: AlertRule[], private webhookUrl?: string | null, private cooldownBlocks = 10) {}

  private key(e: AlertEvent) {
    return `${e.rule.kind}:${JSON.stringify(e.data ?? {})}`;
  }

  async evaluate(currentBlock: number, candidates: AlertEvent[]) {
    for (const e of candidates) {
      const cfg = this.rules.find((r) => r.kind === e.rule.kind);
      if (e.rule.enabled === false || cfg?.enabled === false) continue;
      const k = this.key(e);
      const last = this.firedRecently.get(k);
      if (last !== undefined && currentBlock - last < this.cooldownBlocks) continue;
      this.firedRecently.set(k, currentBlock);
      await this.deliver(e);
    }
  }

  private async deliver(e: AlertEvent) {
    console.log(`🔔 ALERT [${e.rule.kind}] ${e.message}`);
    await this.post(`🔔 ${e.rule.kind}`, e.message);
  }

  /**
   * Out-of-band notification used by the autonomous loop to publish fire
   * receipts (with the on-chain tx hash) to the configured channel.
   */
  async notify(title: string, message: string, opts?: { txHash?: string | null; dryRun?: boolean }) {
    const prefix = opts?.dryRun ? "🧪 (dry-run) " : "🔔 ";
    console.log(`${prefix}${title}: ${message}${opts?.txHash ? ` | tx ${opts.txHash}` : ""}`);
    const desc = opts?.txHash ? `${message}\n\n🧾 on-chain receipt: \`${opts.txHash}\`` : message;
    await this.post(`${prefix}${title}`, desc);
  }

  private async post(title: string, description: string) {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "POT Watch",
          embeds: [{ title, description, color: 0x7c5cff, timestamp: new Date().toISOString() }],
        }),
      });
    } catch (err) {
      console.warn("webhook delivery failed:", (err as Error).message);
    }
  }
}
