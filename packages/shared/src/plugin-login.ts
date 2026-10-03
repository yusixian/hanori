import type { PluginBotState } from "./plugin-runtime.js";

/** A trusted provider must verify the account before returning authorized credentials. */
export type PluginLoginResult =
  | { status: "waiting" | "scanned" | "expired" }
  | {
      status: "authorized";
      secrets: Record<string, string>;
      account: { name: string };
    };

/** Private host object. Only qrUrl and public status cross the management HTTP interface. */
export interface PluginLoginAttempt {
  qrUrl: string;
  poll(signal: AbortSignal): Promise<PluginLoginResult>;
  dispose?(): void | Promise<void>;
}

export interface PluginLoginStart {
  expectedRevision: number;
  manifestHash: string;
}

export interface PluginLoginState {
  id: string;
  status:
    | "waiting"
    | "scanned"
    | "saving"
    | "save_unknown"
    | "connected"
    | "expired"
    | "cancelled"
    | "failed"
    | "conflict";
  expiresAt: string;
  /** Present only while waiting for the user; never send provider session keys separately. */
  qrUrl?: string;
  account?: { name: string };
  /** Public configuration after credentials have been saved successfully. */
  botState?: PluginBotState;
}
