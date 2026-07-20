import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CodingWorkerJob {
  workspacePath: string;
  task: string;
  timeoutMs: number;
  model: {
    apiKey: string;
    baseURL: string;
    id: string;
    providerFormat: "openai" | "gemini";
    maxTokens?: number;
    capabilities: ReadonlyArray<
      "vision" | "tool_calling" | "web_search" | "reasoning" | "long_context" | "code"
    >;
    thinking?: "enabled" | "disabled";
  };
}

export interface CodingWorkerResult {
  summary: string;
  durationMs: number;
}

export interface CodingWorkerOptions {
  secret: string;
  workspacesRoot: string;
  workspaceName?: string;
  bootId?: string;
  runJob?: (
    job: CodingWorkerJob,
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<CodingWorkerResult>;
}

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_TASK_CHARS = 20_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_SUMMARY_CHARS = 12_000;
const HEALTH_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

class RequestTooLargeError extends Error {}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createHealthProof(secret: string, challenge: string, bootId: string): string {
  return createHmac("sha256", secret)
    .update("cos-tool-bot/coding-worker-health/v1\0")
    .update(challenge)
    .update("\0")
    .update(bootId)
    .digest("base64url");
}

async function readRequestText(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytesRead += value.byteLength;
      if (bytesRead > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function validateJob(value: unknown): CodingWorkerJob {
  if (!value || typeof value !== "object") throw new Error("Invalid coding job");
  const job = value as Partial<CodingWorkerJob>;
  if (typeof job.workspacePath !== "string" || !job.workspacePath) {
    throw new Error("workspacePath is required");
  }
  if (path.isAbsolute(job.workspacePath) || job.workspacePath.includes("\\")) {
    throw new Error("workspacePath must be a relative POSIX path");
  }
  const segments = job.workspacePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("workspacePath contains an invalid segment");
  }
  if (typeof job.task !== "string" || !job.task.trim() || job.task.length > MAX_TASK_CHARS) {
    throw new Error("task must contain between 1 and 20000 characters");
  }
  if (
    typeof job.timeoutMs !== "number" ||
    !Number.isInteger(job.timeoutMs) ||
    job.timeoutMs < MIN_TIMEOUT_MS ||
    job.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("timeoutMs must be between 60000 and 1800000");
  }
  const model = job.model;
  if (
    !model ||
    typeof model.apiKey !== "string" ||
    !model.apiKey ||
    typeof model.baseURL !== "string" ||
    !model.baseURL ||
    typeof model.id !== "string" ||
    !model.id ||
    (model.providerFormat !== "openai" && model.providerFormat !== "gemini") ||
    !Array.isArray(model.capabilities)
  ) {
    throw new Error("A valid model configuration is required");
  }
  return job as CodingWorkerJob;
}

export async function resolveWorkspace(root: string, relativePath: string): Promise<string> {
  const resolvedRoot = await realpath(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Workspace escapes the configured root");
  }
  const actual = await realpath(candidate);
  if (actual !== candidate) throw new Error("Workspace path must not contain symlinks");
  const info = await stat(actual);
  if (!info.isDirectory()) throw new Error("Workspace is not a directory");
  return actual;
}

function assistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      errorMessage?: string;
    };
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.slice(0, MAX_SUMMARY_CHARS);
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (text) return text.slice(0, MAX_SUMMARY_CHARS);
    }
    if (message.errorMessage) return message.errorMessage.slice(0, MAX_SUMMARY_CHARS);
  }
  return "Pi completed without a textual summary.";
}

export async function createPiRuntime(job: CodingWorkerJob, workspace: string, agentDir: string) {
  const { DefaultResourceLoader, ModelRuntime, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const provider = "cos-tool-bot-runtime";
  const api = job.model.providerFormat === "gemini" ? "google-generative-ai" : "openai-completions";
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(provider, {
    name: "Cos Tool Bot Runtime",
    baseUrl: job.model.baseURL,
    api,
    models: [
      {
        id: job.model.id,
        name: job.model.id,
        api,
        reasoning:
          job.model.capabilities.includes("reasoning") && job.model.thinking !== "disabled",
        input: job.model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: job.model.capabilities.includes("long_context") ? 128_000 : 32_000,
        maxTokens: job.model.maxTokens ?? 8_192,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(provider, job.model.apiKey);
  const model = modelRuntime.getModel(provider, job.model.id);
  if (!model) throw new Error(`Failed to register Pi model ${provider}/${job.model.id}`);

  const settingsManager = SettingsManager.create(workspace, agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
  });
  await resourceLoader.reload();

  return { modelRuntime, model, settingsManager, resourceLoader };
}

export async function runPiJob(
  job: CodingWorkerJob,
  workspace: string,
  signal?: AbortSignal,
): Promise<CodingWorkerResult> {
  const startedAt = Date.now();
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
  const jobHome = path.join(agentDir, "home");
  const jobCache = path.join(workspace, ".cos-pi-cache");
  await mkdir(jobHome, { recursive: true });
  const environmentOverrides = {
    HOME: jobHome,
    NPM_CONFIG_CACHE: path.join(jobCache, "npm"),
    NPM_CONFIG_STORE_DIR: path.join(jobCache, "pnpm-store"),
    XDG_CACHE_HOME: path.join(jobCache, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(agentDir, "xdg-config"),
    XDG_DATA_HOME: path.join(jobCache, "xdg-data"),
  } as const;
  const previousEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(environmentOverrides)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  const restoreEnvironment = () => {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const { session } = await (async () => {
    try {
      const { createAgentSession, SessionManager } =
        await import("@earendil-works/pi-coding-agent");
      const { modelRuntime, model, settingsManager, resourceLoader } = await createPiRuntime(
        job,
        workspace,
        agentDir,
      );
      return await createAgentSession({
        cwd: workspace,
        agentDir,
        modelRuntime,
        model,
        settingsManager,
        resourceLoader,
        thinkingLevel: model.reasoning ? "medium" : undefined,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        sessionManager: SessionManager.inMemory(workspace),
      });
    } catch (error) {
      restoreEnvironment();
      await rm(agentDir, { recursive: true, force: true });
      throw error;
    }
  })();
  const timeoutController = new AbortController();
  const jobSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const prompt = [
      "You are Ai-chan's isolated coding worker.",
      "Work only in the current repository and implement the requested change completely.",
      "Inspect repository guidance, keep the change focused, and run relevant tests.",
      "Do not push, change git remotes, add credentials, or contact GitHub APIs.",
      "Do not commit: the trusted broker will create the commit after you finish.",
      "Finish with a concise summary of changes and tests.",
      "",
      "Task:",
      job.task,
    ].join("\n");
    timeout = setTimeout(
      () => timeoutController.abort(new Error(`Pi coding job timed out after ${job.timeoutMs}ms`)),
      job.timeoutMs,
    );
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        void session.abort();
        reject(jobSignal.reason);
      };
      if (jobSignal.aborted) {
        onAbort();
        return;
      }
      jobSignal.addEventListener("abort", onAbort, { once: true });
      session
        .prompt(prompt, { expandPromptTemplates: false, source: "rpc" })
        .then(resolve, reject)
        .finally(() => jobSignal.removeEventListener("abort", onAbort));
    });
    return { summary: assistantText(session.messages), durationMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      session.dispose();
    } finally {
      restoreEnvironment();
      await rm(agentDir, { recursive: true, force: true });
    }
  }
}

export function createCodingWorkerHandler(options: CodingWorkerOptions) {
  let busy = false;
  const execute = options.runJob ?? runPiJob;
  const workspaceName = options.workspaceName ?? "workspace";
  const bootId = options.bootId ?? randomUUID();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const challenge = url.searchParams.get("challenge");
      if (!challenge) return json({ ok: true, busy, bootId });
      if (!HEALTH_CHALLENGE_RE.test(challenge)) {
        return json({ error: "Invalid health challenge" }, 400);
      }
      return json({
        ok: true,
        busy,
        bootId,
        challenge,
        proof: createHealthProof(options.secret, challenge, bootId),
      });
    }
    if (request.method !== "POST" || url.pathname !== "/jobs")
      return json({ error: "Not found" }, 404);
    const authorization = request.headers.get("Authorization") ?? "";
    if (
      !authorization.startsWith("Bearer ") ||
      !secureEqual(authorization.slice(7), options.secret)
    ) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (busy) return json({ error: "Coding worker is busy" }, 409);
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_REQUEST_BYTES) return json({ error: "Request too large" }, 413);

    busy = true;
    let modelKey: string | undefined;
    try {
      const raw = await readRequestText(request);
      const job = validateJob(JSON.parse(raw));
      if (job.workspacePath !== workspaceName) {
        throw new Error("Only the fixed staging workspace is allowed");
      }
      modelKey = job.model.apiKey;
      const workspace = await resolveWorkspace(options.workspacesRoot, job.workspacePath);
      const response = json({ ok: true, result: await execute(job, workspace, request.signal) });
      response.headers.set("X-Coding-Worker-One-Shot", "true");
      return response;
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        const response = json({ error: "Request too large" }, 413);
        response.headers.set("X-Coding-Worker-One-Shot", "true");
        return response;
      }
      const message = error instanceof Error ? error.message : String(error);
      const response = json(
        { error: modelKey ? message.split(modelKey).join("[redacted]") : message },
        400,
      );
      response.headers.set("X-Coding-Worker-One-Shot", "true");
      return response;
    } finally {
      busy = false;
    }
  };
}
