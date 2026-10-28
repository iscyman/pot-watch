/**
 * firer.ts — native-surface writer for the autonomous loop.
 *
 * recordFire goes through `revive.call` on the NATIVE surface (~0.015 tPOT per
 * fire) — the same proven path as contracts/scripts/native-interact.cjs:
 * dry-run via ReviveApi.call to size weight + storage-deposit cap, then
 * signAndSend and wait for finalization.
 *
 * @polkadot/api is imported lazily so detection, tests and the dashboard data
 * path stay dependency-light; only machines that actually fire need it.
 *
 * Safety: the loop wallet mnemonic is read from an environment variable
 * (config.loop.mnemonicEnv). It is never written to disk or logged.
 */
export interface FireOpts {
  wsUrl: string;
  mnemonic: string;
  contract: string;        // 0x… H160 of AlertRegistry
  calldata: string;        // 0x… encoded recordFire(id)
  label?: string;
  ss58Format?: number;
}

export interface FireResult {
  txHash: string;
  blockHash: string;
  blockNumber: number;
  success: boolean;
  events: string[];
  label: string;
}

export async function submitFireNative(opts: FireOpts): Promise<FireResult> {
  // lazy: only fire-capable runs pay the import cost
  const { ApiPromise, WsProvider, Keyring } = await import("@polkadot/api");

  const api = await ApiPromise.create({ provider: new WsProvider(opts.wsUrl) });
  try {
    const keyring = new Keyring({ type: "sr25519", ss58Format: opts.ss58Format ?? 42 });
    const kp = keyring.addFromMnemonic(opts.mnemonic);

    let weight: { refTime: bigint; proofSize: bigint } = {
      refTime: 200_000_000_000n,
      proofSize: 1_000_000n,
    };
    let sdepCap = 5n * 10n ** 14n; // 5 tPOT ceiling; real writes are ~0.015 tPOT
    try {
      const dry = await api.call.reviveApi.call(
        "0x" + Buffer.from(kp.publicKey).toString("hex"),
        opts.contract,
        0,
        weight,
        50n * 10n ** 14n,
        opts.calldata
      );
      const j: any = dry.toJSON();
      if (j.weightRequired) {
        weight = {
          refTime: BigInt(Math.ceil(Number(j.weightRequired.refTime) * 1.5)) + 10n ** 9n,
          proofSize: BigInt(Math.ceil(Number(j.weightRequired.proofSize) * 1.5)) + 10n ** 4n,
        };
      }
      const maxSD = j.maxStorageDeposit?.charge !== undefined ? BigInt(j.maxStorageDeposit.charge) : 0n;
      const actSD = j.storageDeposit?.charge !== undefined ? BigInt(j.storageDeposit.charge) : 0n;
      const basis = maxSD > actSD ? maxSD : actSD;
      if (basis > 0n) sdepCap = (basis * 130n) / 100n + 10n ** 13n;
    } catch {
      /* dry-run optional — defaults are proven sufficient for recordFire */
    }

    const tx = api.tx.revive.call(opts.contract, 0, weight, sdepCap, opts.calldata);
    const out = await new Promise<{ txHash: string; blockHash: string; events: any[] }>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("finalization timeout (120s)")), 120_000);
      tx.signAndSend(kp, ({ status, events, txHash }) => {
        if (status.isFinalized) {
          clearTimeout(to);
          resolve({ txHash: txHash.toHex(), blockHash: status.asFinalized.toHex(), events });
        }
      }).catch((e: Error) => {
        clearTimeout(to);
        reject(e);
      });
    });

    const header = await api.rpc.chain.getHeader(out.blockHash);
    const names = out.events.map(({ event }: any) => `${event.section}.${event.method}`);
    return {
      txHash: out.txHash,
      blockHash: out.blockHash,
      blockNumber: header.number.toNumber(),
      success: names.includes("system.ExtrinsicSuccess"),
      events: names,
      label: opts.label ?? "recordFire",
    };
  } finally {
    await api.disconnect();
  }
}
