import type { ExecFileLike } from "./lody.js";

/** Grace beyond the command timeout for the bridge to kill the child and answer. */
const RESPONSE_GRACE_MS = 5_000;
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]);

interface BridgeResult {
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  truncated?: boolean;
  stdout?: string;
  spawnError?: string;
}

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
        body: JSON.stringify({ args, stdin: options.input, timeoutMs: options.timeout }),
        signal: AbortSignal.timeout(options.timeout + RESPONSE_GRACE_MS),
      });
    } catch (error) {
      const code = causeCode(error);
      if (code && UNREACHABLE.has(code)) {
        throw execError({ code: "EBRIDGE_UNREACHABLE" }, `无法连接 lody-bridge（${code}）`);
      }
      throw execError({ killed: true, code });
    }
    if (response.status === 401) throw rejected("lody-bridge 拒绝了认证，请检查共享密钥");
    if (response.status === 400) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw rejected(`lody-bridge 拒绝了参数：${body?.error ?? "未知"}`);
    }
    let result: BridgeResult;
    try {
      if (!response.ok) throw new Error(String(response.status));
      result = (await response.json()) as BridgeResult;
    } catch {
      throw execError({ killed: true });
    }
    if (result.spawnError) throw execError({ code: result.spawnError });
    const stdout = result.stdout ?? "";
    if (result.timedOut || result.truncated || result.signal) {
      throw execError({ killed: true, signal: result.signal ?? "SIGKILL", stdout });
    }
    if (result.exitCode !== 0) throw execError({ code: result.exitCode ?? "exit", stdout });
    if (stdout.length > options.maxBuffer) throw execError({ killed: true });
    return { stdout };
  };
}
