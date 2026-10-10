import type { LodyExecutorConfig } from "./config/schema.js";
import { durationMs } from "./config/units.js";
import { type ExecFileLike, LodyCli } from "./lody.js";
import { createBridgeExec, createBridgeRuntimeClient } from "./lody-bridge.js";
import { type TurnEnd, createLocalExec } from "./lody-wait.js";

export type CreateLody = (
  command: string[],
  timeoutMs: number,
  exec?: ExecFileLike,
  turnWaitSeconds?: number | null,
) => LodyCli;

export const defaultCreateLody: CreateLody = (command, timeoutMs, exec, turnWait) =>
  new LodyCli(command, timeoutMs, exec, undefined, turnWait ?? null);

/**
 * Builds the Lody client for the current config and environment: the lody-bridge sidecar when its
 * URL is set, else the local CLI. Turns started with `turnWait` report their end through the
 * bridge callback, or in-process through the local waiter pool, which outlives client rebuilds.
 */
export class LodyClients {
  private client: { key: string; bridgeSecret: string | undefined; cli: LodyCli } | null = null;
  private readonly localExec: ExecFileLike;

  constructor(
    private readonly create: CreateLody,
    private readonly readEnv: (name: string) => string | undefined,
    onTurnEnd: (end: TurnEnd) => void,
  ) {
    this.localExec = createLocalExec(onTurnEnd);
  }

  get(lody: LodyExecutorConfig): LodyCli {
    const command = typeof lody.cli === "string" ? [lody.cli] : lody.cli;
    const bridgeUrl = this.readEnv(lody.bridge.urlEnv);
    const bridgeSecret = bridgeUrl ? this.readEnv(lody.bridge.secretEnv) : undefined;
    const turnWait = lody.turnWait ? Math.round(durationMs(lody.turnWait) / 1000) : null;
    const key = JSON.stringify([command, lody.timeout, bridgeUrl ?? null, turnWait]);
    if (this.client?.key !== key || this.client.bridgeSecret !== bridgeSecret) {
      const exec = bridgeUrl ? createBridgeExec(bridgeUrl, bridgeSecret) : this.localExec;
      this.client = {
        key,
        bridgeSecret,
        cli: this.create(command, durationMs(lody.timeout), exec, turnWait),
      };
    }
    return this.client.cli;
  }

  transport(lody: LodyExecutorConfig): "bridge" | "local" {
    return this.readEnv(lody.bridge.urlEnv) ? "bridge" : "local";
  }

  runtime(lody: LodyExecutorConfig) {
    const url = this.readEnv(lody.bridge.urlEnv);
    return url ? createBridgeRuntimeClient(url, this.readEnv(lody.bridge.secretEnv)) : null;
  }
}
