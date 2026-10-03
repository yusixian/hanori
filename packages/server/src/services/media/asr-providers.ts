import { createHash, createHmac } from "node:crypto";
import type { TranscriptDocument } from "@cos-tool-bot/shared";
import type { MediaJobConfiguration } from "../media-jobs/contracts.js";
import { AsrClientError, createAsrClient, type AsrFailure } from "./asr.js";
import { MediaHttpError, readMediaDocument, sendMediaJsonDocument } from "./http.js";
import { inspectConvertedWav } from "./wav.js";

export interface MediaAsrOptions {
  signal?: AbortSignal;
  /** A trusted host creates a temporary URL for the exact validated audio. */
  audioUrl?: string;
  onProviderTask?(id: string): Promise<void>;
}
export interface MediaAsrClient {
  transcribeBytes(bytes: Buffer, options?: MediaAsrOptions): Promise<TranscriptDocument>;
  resume?(
    taskId: string,
    submittedAt: Date,
    signal?: AbortSignal,
    durationSeconds?: number,
  ): Promise<TranscriptDocument>;
}

const TENCENT_HOST = "asr.tencentcloudapi.com";
const ALIYUN_HOST = "dashscope.aliyuncs.com";
const MAX_AUDIO_SECONDS = (20 * 1024 * 1024 - 44) / 32_000;
const MAX_WAIT_MS = 30 * 60_000;
const TASK_VALID_MS = 24 * 60 * 60_000;
const TENCENT_MODELS = new Set([
  "16k_zh",
  "16k_en",
  "16k_yue",
  "16k_zh-PY",
  "16k_zh-TW",
  "16k_en_large",
  "16k_zh_en",
  "16k_zh_en_2.0",
  "16k_zh_en_meeting",
]);

function invalid(code: AsrFailure = "invalid_response"): never {
  throw new AsrClientError(code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function parse(bytes: Buffer, preserveIntegerIds = false): Record<string, unknown> {
  if (bytes.length > 2 * 1024 * 1024) invalid("too_large");
  try {
    const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // JSON.parse rounds uint64 task IDs. Match whole JSON strings first so their text is untouched.
    // Other numeric fields remain subject to their strict number/timestamp checks below.
    const json = preserveIntegerIds
      ? input.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
          /^[1-9]\d{15,19}$/.test(token) && !Number.isSafeInteger(Number(token))
            ? JSON.stringify(token)
            : token,
        )
      : input;
    return record(JSON.parse(json));
  } catch (error) {
    if (error instanceof AsrClientError) throw error;
    return invalid();
  }
}
function normalize(error: unknown, signal?: AbortSignal): AsrClientError {
  if (signal?.aborted) return new AsrClientError("cancelled");
  if (error instanceof AsrClientError) return error;
  if (error instanceof MediaHttpError)
    return new AsrClientError(
      error.code === "invalid_content"
        ? "invalid_response"
        : error.code === "invalid_request"
          ? "invalid_configuration"
          : error.code,
    );
  return new AsrClientError("upstream_error");
}
function audioUrl(value: string | undefined): string {
  try {
    if (!value || value.length > 4096 || /[\s\\]/.test(value)) invalid("invalid_configuration");
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
      /\.(?:local|localhost|internal|test|invalid)$/.test(url.hostname)
    )
      invalid("invalid_configuration");
    return url.href;
  } catch {
    return invalid("invalid_configuration");
  }
}
function duration(value: number) {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_AUDIO_SECONDS) invalid();
  return value;
}
function inputDuration(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes)) invalid("invalid_file");
  if (bytes.length > 20 * 1024 * 1024) invalid("too_large");
  try {
    return inspectConvertedWav(bytes, MAX_AUDIO_SECONDS).durationSeconds;
  } catch {
    return invalid("invalid_file");
  }
}
function document(segments: unknown, audioSeconds: number, language?: string): TranscriptDocument {
  if (!Array.isArray(segments)) invalid("timing_unavailable");
  if (segments.length > 10_000) invalid();
  let previousStart = -1;
  let previousEnd = -1;
  let chars = 0;
  const cues = segments.map((raw) => {
    const cue = record(raw);
    if (
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      (cue.startMs as number) < 0 ||
      (cue.endMs as number) <= (cue.startMs as number) ||
      (cue.endMs as number) > Math.round((audioSeconds + 2) * 1000) ||
      (cue.startMs as number) < previousStart ||
      (cue.endMs as number) < previousEnd ||
      typeof cue.text !== "string" ||
      cue.text.length > 16_384
    )
      invalid();
    previousStart = cue.startMs as number;
    previousEnd = cue.endMs as number;
    chars += cue.text.length;
    if (chars > 500_000) invalid();
    // These providers expose no recognition confidence; speaker/energy fields are not confidence.
    return { startMs: previousStart, endMs: previousEnd, text: cue.text };
  });
  return { source: "asr", track: "original", language: language ?? null, cues };
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  submittedAt?: Date,
  persistence?: { pending?: Promise<void> },
) {
  let timeoutMs = MAX_WAIT_MS;
  if (submittedAt) {
    if (!(submittedAt instanceof Date)) invalid("unavailable");
    const age = Date.now() - submittedAt.getTime();
    if (!Number.isFinite(age) || age < -300_000 || age >= TASK_VALID_MS) invalid("unavailable");
    timeoutMs = Math.min(timeoutMs, TASK_VALID_MS - Math.max(0, age));
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    return await abortable(operation(combined), combined);
  } catch (error) {
    if (signal?.aborted) invalid("cancelled");
    if (deadline.signal.aborted) invalid("timeout");
    throw normalize(error);
  } finally {
    try {
      // Once a billable submit returned an ID, shutdown must wait for its durable handoff.
      await persistence?.pending;
    } catch {
      invalid("upstream_error");
    } finally {
      clearTimeout(timer);
    }
  }
}
async function poll(
  query: () => Promise<TranscriptDocument | null>,
  signal: AbortSignal,
): Promise<TranscriptDocument> {
  while (true) {
    signal.throwIfAborted();
    let result;
    try {
      result = await query();
    } catch (error) {
      const failure = normalize(error, signal);
      if (
        !(error instanceof MediaHttpError) ||
        !["rate_limited", "timeout", "upstream_error"].includes(failure.code)
      )
        throw failure;
    }
    if (result) return result;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 3000);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function tencentTask(value: unknown): string {
  const id =
    typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : invalid();
  if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 18_446_744_073_709_551_615n) invalid();
  return id;
}
function tencentFailure(code: unknown): AsrFailure {
  if (typeof code !== "string") invalid();
  if (/^(?:AuthFailure|UnauthorizedOperation)/.test(code)) return "forbidden";
  if (/^(?:RequestLimitExceeded|LimitExceeded)/.test(code)) return "rate_limited";
  if (/^FailedOperation\.(?:UserHasNoFreeAmount|ServiceIsolate|NoSuchTask)$/.test(code))
    return "unavailable";
  if (/^(?:InvalidParameter|MissingParameter|UnknownParameter)/.test(code))
    return "invalid_configuration";
  return "upstream_error";
}
function tencentClient(config: MediaJobConfiguration["asr"]): MediaAsrClient {
  if (
    !config.secretId ||
    !/^[A-Za-z0-9]{1,128}$/.test(config.secretId) ||
    !config.secretKey ||
    !/^[!-~]{1,4096}$/.test(config.secretKey) ||
    !config.region ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(config.region) ||
    !TENCENT_MODELS.has(config.model)
  )
    invalid("invalid_configuration");
  const { secretId, secretKey, region, model, language } = config;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value).digest();
  async function request(
    action: "CreateRecTask" | "DescribeTaskStatus",
    value: unknown,
    signal: AbortSignal,
  ) {
    const payload =
      action === "DescribeTaskStatus"
        ? `{"TaskId":${tencentTask(record(value).TaskId)}}`
        : JSON.stringify(value);
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const scope = `${date}/asr/tc3_request`;
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${TENCENT_HOST}\n\ncontent-type;host\n${hash(payload)}`;
    const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), "asr"), "tc3_request");
    const signature = hmac(
      signingKey,
      `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`,
    ).toString("hex");
    const response = await sendMediaJsonDocument(
      `https://${TENCENT_HOST}/`,
      {
        allowedHosts: [TENCENT_HOST],
        mimeTypes: ["application/json"],
        signal,
        credential: {
          origin: `https://${TENCENT_HOST}`,
          authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
        },
      },
      Buffer.from(payload),
      {
        "X-TC-Action": action,
        "X-TC-Version": "2019-06-14",
        "X-TC-Region": region,
        "X-TC-Timestamp": String(timestamp),
      },
    );
    const envelope = record(parse(response.bytes, true).Response);
    if (envelope.Error) invalid(tencentFailure(record(envelope.Error).Code));
    return record(envelope.Data);
  }
  async function wait(
    taskId: string,
    audioSeconds: number,
    signal: AbortSignal,
    submittedDate = new Date().toISOString().slice(0, 10),
  ) {
    return poll(async () => {
      if (new Date().toISOString().slice(0, 10) !== submittedDate) invalid("unavailable");
      const data = await request("DescribeTaskStatus", { TaskId: taskId }, signal);
      if (tencentTask(data.TaskId) !== taskId) invalid();
      if (data.Status === 0 || data.Status === 1) return null;
      // Recognition failure is terminal, not a transient request failure eligible for query retry.
      if (data.Status === 3) invalid("invalid_response");
      if (data.Status !== 2) invalid();
      if (
        data.AudioDuration !== undefined &&
        (typeof data.AudioDuration !== "number" ||
          !Number.isFinite(data.AudioDuration) ||
          data.AudioDuration < 0 ||
          data.AudioDuration > audioSeconds + 2)
      )
        invalid();
      const segments = Array.isArray(data.ResultDetail)
        ? data.ResultDetail.map((raw) => {
            const sentence = record(raw);
            return {
              startMs: sentence.StartMs,
              endMs: sentence.EndMs,
              text: sentence.FinalSentence,
            };
          })
        : undefined;
      if (
        Array.isArray(segments) &&
        !segments.length &&
        typeof data.Result === "string" &&
        data.Result.trim()
      )
        invalid("timing_unavailable");
      return document(segments, audioSeconds, language);
    }, signal);
  }
  return {
    transcribeBytes(bytes, options = {}) {
      const persistence: { pending?: Promise<void> } = {};
      return bounded(
        async (signal) => {
          const audioSeconds = inputDuration(bytes);
          const input =
            bytes.length <= 5 * 1024 * 1024
              ? { SourceType: 1, Data: bytes.toString("base64"), DataLen: bytes.length }
              : { SourceType: 0, Url: audioUrl(options.audioUrl) };
          const submittedDate = new Date().toISOString().slice(0, 10);
          const data = await request(
            "CreateRecTask",
            {
              EngineModelType: model,
              ChannelNum: 1,
              ResTextFormat: 3,
              ...input,
            },
            signal,
          );
          const taskId = tencentTask(data.TaskId);
          persistence.pending = Promise.resolve().then(() => options.onProviderTask?.(taskId));
          await persistence.pending;
          signal.throwIfAborted();
          return wait(taskId, audioSeconds, signal, submittedDate);
        },
        options.signal,
        undefined,
        persistence,
      );
    },
    resume(taskId, submittedAt, signal, audioSeconds = MAX_AUDIO_SECONDS) {
      tencentTask(taskId);
      if (!(submittedAt instanceof Date) || !Number.isFinite(submittedAt.getTime()))
        invalid("unavailable");
      // The API has no creation timestamp and warns that IDs can repeat on different dates.
      if (submittedAt.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10))
        invalid("unavailable");
      return bounded(
        (callSignal) => wait(taskId, duration(audioSeconds), callSignal),
        signal,
        submittedAt,
      );
    },
  };
}

function aliyunClient(config: MediaJobConfiguration["asr"]): MediaAsrClient {
  if (
    typeof config.apiKey !== "string" ||
    !/^[!-~]{1,4096}$/.test(config.apiKey) ||
    config.model !== "paraformer-v2" ||
    !["https://dashscope.aliyuncs.com/api/v1", "https://dashscope.aliyuncs.com/api/v1/"].includes(
      config.baseUrl,
    )
  )
    invalid("invalid_configuration");
  const { apiKey, model, language } = config;
  const authorization = { origin: `https://${ALIYUN_HOST}`, authorization: `Bearer ${apiKey}` };
  function taskId(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(value)) invalid();
    return value;
  }
  async function wait(id: string, audioSeconds: number, signal: AbortSignal) {
    return poll(async () => {
      const response = await readMediaDocument(`https://${ALIYUN_HOST}/api/v1/tasks/${id}`, {
        allowedHosts: [ALIYUN_HOST],
        mimeTypes: ["application/json"],
        maxRedirects: 0,
        maxBytes: 2 * 1024 * 1024,
        signal,
        credential: authorization,
      });
      const value = parse(response.bytes);
      if (value.code) invalid(value.code === "InvalidApiKey" ? "forbidden" : "invalid_response");
      const output = record(value.output);
      if (taskId(output.task_id) !== id) invalid();
      if (output.task_status === "PENDING" || output.task_status === "RUNNING") return null;
      if (
        output.task_status !== "SUCCEEDED" ||
        !Array.isArray(output.results) ||
        output.results.length !== 1
      )
        invalid();
      const result = record(output.results[0]);
      if (result.subtask_status !== "SUCCEEDED") invalid();
      if (typeof result.transcription_url !== "string") invalid();
      let url: URL;
      try {
        url = new URL(result.transcription_url);
      } catch {
        return invalid();
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        !/^dashscope-result(?:-bj)?\.oss-cn-beijing\.aliyuncs\.com$/.test(url.hostname)
      )
        invalid();
      const transcript = await readMediaDocument(url.href, {
        allowedHosts: [url.hostname],
        mimeTypes: ["application/json"],
        maxRedirects: 0,
        maxBytes: 2 * 1024 * 1024,
        signal,
      });
      const transcriptions = parse(transcript.bytes).transcripts;
      if (!Array.isArray(transcriptions) || transcriptions.length > 2) invalid();
      const track = transcriptions.find((item) => record(item).channel_id === 0);
      if (!track) invalid();
      const data = record(track);
      const segments = Array.isArray(data.sentences)
        ? data.sentences.map((raw) => {
            const sentence = record(raw);
            return { startMs: sentence.begin_time, endMs: sentence.end_time, text: sentence.text };
          })
        : undefined;
      if (
        Array.isArray(segments) &&
        !segments.length &&
        typeof data.text === "string" &&
        data.text.trim()
      )
        invalid("timing_unavailable");
      return document(segments, audioSeconds, language);
    }, signal);
  }
  return {
    transcribeBytes(bytes, options = {}) {
      const persistence: { pending?: Promise<void> } = {};
      return bounded(
        async (signal) => {
          const audioSeconds = inputDuration(bytes);
          const response = await sendMediaJsonDocument(
            `https://${ALIYUN_HOST}/api/v1/services/audio/asr/transcription`,
            {
              allowedHosts: [ALIYUN_HOST],
              mimeTypes: ["application/json"],
              signal,
              credential: authorization,
            },
            Buffer.from(
              JSON.stringify({
                model,
                input: { file_urls: [audioUrl(options.audioUrl)] },
                parameters: {
                  channel_id: [0],
                  disfluency_removal_enabled: false,
                  ...(language ? { language_hints: [language] } : {}),
                },
              }),
            ),
            { "X-DashScope-Async": "enable" },
          );
          const value = parse(response.bytes);
          if (value.code) invalid(value.code === "InvalidApiKey" ? "forbidden" : "upstream_error");
          const output = record(value.output);
          if (output.task_status !== "PENDING" && output.task_status !== "RUNNING") invalid();
          const id = taskId(output.task_id);
          persistence.pending = Promise.resolve().then(() => options.onProviderTask?.(id));
          await persistence.pending;
          signal.throwIfAborted();
          return wait(id, audioSeconds, signal);
        },
        options.signal,
        undefined,
        persistence,
      );
    },
    resume(id, submittedAt, signal, audioSeconds = MAX_AUDIO_SECONDS) {
      return bounded(
        (callSignal) => wait(taskId(id), duration(audioSeconds), callSignal),
        signal,
        submittedAt,
      );
    },
  };
}

/** One explicitly selected provider per task. Submission is never retried or silently switched. */
export function createMediaAsrClient(config: MediaJobConfiguration["asr"]): MediaAsrClient {
  if (
    config.language !== undefined &&
    (typeof config.language !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(config.language))
  )
    invalid("invalid_configuration");
  if (config.provider === "tencent") return tencentClient(config);
  if (config.provider === "aliyun") return aliyunClient(config);
  if (config.provider === "groq" && config.baseUrl !== "https://api.groq.com/openai/v1")
    invalid("invalid_configuration");
  if (config.provider !== undefined && !["openai", "groq"].includes(config.provider))
    invalid("invalid_configuration");
  const client = createAsrClient(config);
  return { transcribeBytes: (bytes, options) => client.transcribeBytes(bytes, options?.signal) };
}
