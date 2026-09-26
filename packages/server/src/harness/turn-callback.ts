import { createHmac, timingSafeEqual } from "node:crypto";
import type { TurnEnd, TurnStatus } from "./lody-wait.js";
import { errorText } from "./pr-actions.js";
import type { HarnessService } from "./service.js";

/** A signed callback older or newer than this is refused as a replay or a skewed clock. */
export const TURN_CALLBACK_MAX_SKEW_MS = 5 * 60_000;
const MIN_SECRET_LENGTH = 32;
const SESSION_ID = /^[\w-]{1,128}$/;
const STATUSES = new Set<string>(["completed", "failed", "canceled", "timeout"]);

export interface LodyTurnRequest {
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
}

export interface LodyTurnResponse {
  status: 202 | 400 | 401 | 404;
  body: { ok: boolean; error?: string };
}

/** `sha256=` + hex HMAC of `<timestamp>.<body>`; the bridge's waiter.mjs signs the same way. */
export function signTurnEnd(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyTurnSignature(
  secret: string,
  request: LodyTurnRequest,
  nowMs: number,
): boolean {
  const { timestamp, signature, body } = request;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(nowMs - Number(timestamp) * 1000) > TURN_CALLBACK_MAX_SKEW_MS) return false;
  const expected = Buffer.from(signTurnEnd(secret, timestamp, body));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Only the fields the harness acts on; anything else in the body is ignored. */
export function parseTurnEnd(body: string): TurnEnd | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const { sessionId, turnId, command, status, exitCode, startedAt, endedAt } = json;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  if (turnId !== undefined && (typeof turnId !== "string" || !SESSION_ID.test(turnId))) return null;
  if (command !== "create" && command !== "chat") return null;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  return {
    sessionId,
    ...(turnId ? { turnId } : {}),
    command,
    status: status as TurnStatus,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    startedAt: typeof startedAt === "string" ? startedAt : "",
    endedAt: typeof endedAt === "string" ? endedAt : "",
  };
}

/**
 * `POST /api/harness/lody/turn` from the lody-bridge: verified with the shared bridge secret,
 * answered at once, and the session's job is checked in the background. Without a configured
 * secret the route does not exist (local CLI mode reports turn ends in-process).
 */
export function receiveTurnEnd(
  service: HarnessService,
  request: LodyTurnRequest,
): LodyTurnResponse {
  if (!service.active) return { status: 404, body: { ok: false, error: "Not found" } };
  const secret = service.readEnv(service.globalView().config.executors.lody.bridge.secretEnv);
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return { status: 404, body: { ok: false, error: "Not found" } };
  }
  if (!verifyTurnSignature(secret, request, service.now().getTime())) {
    return { status: 401, body: { ok: false, error: "invalid signature" } };
  }
  const end = parseTurnEnd(request.body);
  if (!end) return { status: 400, body: { ok: false, error: "invalid body" } };
  void service.work
    .onTurnEnd(end)
    .catch((error) =>
      service.logger.warn(`Dev Harness turn-end check failed: ${errorText(error)}`),
    );
  return { status: 202, body: { ok: true } };
}
