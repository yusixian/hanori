import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { YTDLP_SCRIPT } from "./yt-dlp-script.js";

type FailureCode =
  | "unavailable"
  | "extractor_failed"
  | "timeout"
  | "invalid_response"
  | "limit_exceeded";

export class YtdlpError extends Error {
  constructor(readonly code: FailureCode) {
    super(`yt-dlp failed: ${code}`);
  }
}

export interface YtdlpVideo {
  aid: number;
  bvid: string;
  cid: number;
}

const MAX_BYTES = 8 * 1024 * 1024;
let running = 0;

/** Only the host callback performs network I/O; no Cookie, provider secrets or URLs enter argv. */
export async function extractWithYtdlp(
  operation: "subtitles" | "video",
  video: YtdlpVideo,
  readJson: (url: string, query: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (running >= 2) throw new YtdlpError("unavailable");
  running++;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const controller = new AbortController();
      const child = spawn("python3", ["-I", "-c", YTDLP_SCRIPT], {
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      });
      let failure: unknown;
      let finished = false;
      let result: unknown;
      let resultReceived = false;
      let pending = false;
      let requests = 0;
      let responseBytes = 0;
      let outputBytes = 0;
      let buffer = "";
      const decoder = new StringDecoder("utf8");
      const stop = (error: unknown) => {
        if (finished) return;
        failure ??= error;
        controller.abort(error);
        child.kill("SIGKILL");
      };
      const onAbort = () => stop(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => stop(new YtdlpError("timeout")), 30_000);
      child.stdin.on("error", () => stop(new YtdlpError("extractor_failed")));
      child.on("error", () => stop(new YtdlpError("unavailable")));
      child.on("close", (code) => {
        finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
        if (failure) reject(failure);
        else if (code !== 0 || !resultReceived || buffer.length)
          reject(new YtdlpError("extractor_failed"));
        else resolve(result);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_BYTES) return stop(new YtdlpError("limit_exceeded"));
        buffer += decoder.write(chunk);
        let end: number;
        while (!controller.signal.aborted && (end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message: unknown = JSON.parse(line);
            if (!message || typeof message !== "object" || Array.isArray(message))
              throw new YtdlpError("invalid_response");
            const record = message as Record<string, unknown>;
            if (record.type === "error") {
              stop(
                new YtdlpError(record.code === "unavailable" ? "unavailable" : "extractor_failed"),
              );
            } else if (record.type === "result" && !pending && !resultReceived) {
              result = record.value;
              resultReceived = true;
              child.stdin.end();
            } else if (
              record.type === "request" &&
              !pending &&
              !resultReceived &&
              typeof record.url === "string" &&
              record.query &&
              typeof record.query === "object" &&
              !Array.isArray(record.query)
            ) {
              if (++requests > 102) throw new YtdlpError("limit_exceeded");
              pending = true;
              void readJson(record.url, record.query as Record<string, unknown>, controller.signal)
                .then((value) => {
                  if (controller.signal.aborted) return;
                  const response = JSON.stringify({ ok: true, value }) + "\n";
                  responseBytes += Buffer.byteLength(response);
                  if (responseBytes > MAX_BYTES) throw new YtdlpError("limit_exceeded");
                  pending = false;
                  child.stdin.write(response);
                })
                .catch(stop);
            } else throw new YtdlpError("invalid_response");
          } catch (error) {
            stop(error instanceof YtdlpError ? error : new YtdlpError("invalid_response"));
          }
        }
      });
      if (signal?.aborted) onAbort();
      else child.stdin.write(JSON.stringify({ operation, video }) + "\n");
    });
  } finally {
    running--;
  }
}
