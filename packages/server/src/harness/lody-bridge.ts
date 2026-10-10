import { z } from "zod";
import type { ExecFileLike } from "./lody.js";
import type { HarnessAdminRuntime, HarnessAdminRuntimeUpdate } from "@cos-tool-bot/shared";

/** Grace beyond the command timeout for the bridge to kill the child and answer. */
const RESPONSE_GRACE_MS = 5_000;
// Includes watchdog recovery, installation, verification, restart and a failed-start rollback.
const RUNTIME_UPDATE_TIMEOUT_MS = 600_000;
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]);

const bridgeResultSchema = z.object({
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  timedOut: z.boolean().optional(),
  truncated: z.boolean().optional(),
  stdout: z.string().optional(),
  spawnError: z.string().optional(),
});
type BridgeResult = z.infer<typeof bridgeResultSchema>;

function execError(fields: Record<string, unknown>, message = "lody-bridge"): Error {
  return Object.assign(new Error(message), fields);
}

/** A rejection the bridge explains is definite: the command never ran. */
function rejected(message: string): Error {
  return execError({ code: 1, stdout: JSON.stringify({ ok: false, error: message }) });
}

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code ?? (error as { code?: string }).code;
}

/**
 * Runs `lody` through the sidecar bridge instead of a local binary. It reports results in the
 * shape of `execFile` so LodyCli keeps one classification: exit 0 resolves; a timeout, signal,
 * overflow, or lost connection is `killed` (unknown outcome); a refused connection means the
 * command never reached Lody.
 */
export function createBridgeExec(
  baseUrl: string,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): ExecFileLike {
  let endpoint: string | null = null;
  try {
    const url = new URL("/exec", baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") endpoint = url.toString();
  } catch {
    endpoint = null;
  }
  return async (_file, args, options) => {
    if (!endpoint) throw execError({ code: "EBRIDGE_CONFIG" }, "lody-bridge 地址无效");
    if (!secret || secret.length < 32) {
      throw execError({ code: "EBRIDGE_CONFIG" }, "lody-bridge 共享密钥未配置或少于 32 个字符");
    }
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          args,
          stdin: options.input,
          timeoutMs: options.timeout,
          turnId: options.turnId,
        }),
        signal: AbortSignal.timeout(options.timeout + RESPONSE_GRACE_MS),
      });
    } catch (error) {
      const code = causeCode(error);
      if (code && UNREACHABLE.has(code)) {
        throw execError({ code: "EBRIDGE_UNREACHABLE" }, `无法连接 lody-bridge（${code}）`);
      }
      throw execError({ killed: true, code });
    }
    if (response.status === 401 || response.status === 429) {
      await response.body?.cancel().catch(() => {});
    }
    if (response.status === 401) throw rejected("lody-bridge 拒绝了认证，请检查共享密钥");
    // Pool full, or a bridge that predates `--wait`: the command never ran, so it may run plain.
    if (response.status === 429) throw execError({ code: "EWAIT_REFUSED" });
    if (response.status === 400 || response.status === 409) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (args.includes("--wait") && /--(wait|timeout|jsonl)\b/.test(body?.error ?? "")) {
        throw execError({ code: "EWAIT_REFUSED" });
      }
      throw rejected(`lody-bridge 拒绝了参数：${body?.error ?? "未知"}`);
    }
    let result: BridgeResult;
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(String(response.status));
      }
      result = bridgeResultSchema.parse(await response.json());
    } catch {
      throw execError({ killed: true });
    }
    if (result.spawnError) throw execError({ code: result.spawnError });
    const stdout = result.stdout ?? "";
    if (result.timedOut || result.truncated || result.signal) {
      throw execError({ killed: true, signal: result.signal ?? "SIGKILL", stdout });
    }
    if (result.exitCode !== 0) throw execError({ code: result.exitCode ?? "exit", stdout });
    if (Buffer.byteLength(stdout, "utf8") > options.maxBuffer) throw execError({ killed: true });
    return { stdout };
  };
}

export function createBridgeRuntimeClient(
  baseUrl: string,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
) {
  async function call<T>(method: "GET" | "POST"): Promise<T> {
    if (!secret || secret.length < 32)
      throw new Error("lody-bridge 共享密钥未配置或少于 32 个字符");
    const endpoint = new URL("/runtime", baseUrl);
    if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("lody-bridge 地址无效");
    const response = await fetchImpl(endpoint, {
      method,
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(method === "GET" ? 15_000 : RUNTIME_UPDATE_TIMEOUT_MS),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      runtime?: T;
      code?: string;
      error?: string;
    };
    if (!response.ok || body.ok !== true || !body.runtime) {
      throw Object.assign(new Error(body.error ?? "lody-bridge 不可达或尚未支持 CLI 更新"), {
        code: body.code,
      });
    }
    return body.runtime;
  }
  return {
    status: () => call<HarnessAdminRuntime>("GET"),
    update: () => call<HarnessAdminRuntimeUpdate>("POST"),
  };
}
