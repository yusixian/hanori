import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaAsrClient } from "./asr-providers.js";
import { AsrClientError } from "./asr.js";
import {
  MediaHttpError,
  readMediaDocument,
  sendMediaDocument,
  sendMediaJsonDocument,
} from "./http.js";

vi.mock("./http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http.js")>()),
  sendMediaJsonDocument: vi.fn(),
  readMediaDocument: vi.fn(),
  sendMediaDocument: vi.fn(),
}));

const now = new Date("2026-10-03T06:00:00Z");
const tencent = {
  provider: "tencent" as const,
  baseUrl: "https://asr.tencentcloudapi.com",
  apiKey: "",
  secretId: "AKIDEXAMPLE",
  secretKey: "synthetic-secret",
  region: "ap-shanghai",
  model: "16k_zh",
};
const aliyun = {
  provider: "aliyun" as const,
  baseUrl: "https://dashscope.aliyuncs.com/api/v1",
  apiKey: "synthetic-key",
  model: "paraformer-v2",
};
const signedAudio = "https://audio.example.com/private.wav?signature=synthetic-private-signature";
function pcm(seconds = 3) {
  const bytes = Buffer.alloc(44 + seconds * 32_000);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
function reply(value: unknown, post = true) {
  const result = {
    bytes: Buffer.from(JSON.stringify(value)),
    url: "",
    mimeType: "application/json",
  };
  if (post) vi.mocked(sendMediaJsonDocument).mockResolvedValueOnce(result);
  else vi.mocked(readMediaDocument).mockResolvedValueOnce(result);
}
function tcComplete(overrides: Record<string, unknown> = {}) {
  return {
    Response: {
      Data: {
        TaskId: 42,
        Status: 2,
        AudioDuration: 3,
        ResultDetail: [
          {
            StartMs: 200,
            EndMs: 2200,
            FinalSentence: "测试识别。",
            SpeakerId: 99,
            SpeechSpeed: 0.01,
            Confidence: 0.1,
          },
        ],
        ...overrides,
      },
    },
  };
}
function aliComplete(
  url = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json?Signature=synthetic",
) {
  return {
    output: {
      task_id: "task-42",
      task_status: "SUCCEEDED",
      results: [
        {
          subtask_status: "SUCCEEDED",
          transcription_url: url,
        },
      ],
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Tencent recorded ASR", () => {
  it("submits a two-hour verified file URL without buffering audio and restores its long duration", async () => {
    reply({ Response: { Data: { TaskId: 42 } } });
    reply(
      tcComplete({
        AudioDuration: 7200,
        ResultDetail: [{ StartMs: 7_199_000, EndMs: 7_200_000, FinalSentence: "Last sentence" }],
      }),
    );
    const onProviderTask = vi.fn(async () => {});
    const result = await createMediaAsrClient(tencent).transcribeUrl!(signedAudio, 7200, {
      onProviderTask,
    });
    const input = JSON.parse(vi.mocked(sendMediaJsonDocument).mock.calls[0]![2].toString());
    expect(input).toMatchObject({ SourceType: 0, Url: signedAudio });
    expect(input).not.toHaveProperty("Data");
    expect(onProviderTask).toHaveBeenCalledExactlyOnceWith("42");
    expect(result.cues[0]?.endMs).toBe(7_200_000);
    vi.clearAllMocks();
    reply(
      tcComplete({
        AudioDuration: 7200,
        ResultDetail: [{ StartMs: 7_199_000, EndMs: 7_200_000, FinalSentence: "Restored" }],
      }),
    );
    expect(
      (await createMediaAsrClient(tencent).resume!("42", now, undefined, 7200)).cues[0]?.text,
    ).toBe("Restored");
    expect(vi.mocked(sendMediaJsonDocument).mock.calls[0]![3]).toMatchObject({
      "X-TC-Action": "DescribeTaskStatus",
    });
  });

  it.each([0, -1, NaN, Infinity, 18_001])(
    "rejects invalid URL audio duration %s before a billable submit",
    async (seconds) => {
      await expect(
        createMediaAsrClient(tencent).transcribeUrl!(signedAudio, seconds),
      ).rejects.toBeInstanceOf(AsrClientError);
      expect(sendMediaJsonDocument).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "timeout"])(
    "drains a known task persistence before rejecting on %s",
    async (reason) => {
      reply({ Response: { Data: { TaskId: 42 } } });
      let release!: () => void;
      const persisted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onProviderTask = vi.fn(() => persisted);
      const controller = new AbortController();
      let settled = false;
      const result = createMediaAsrClient(tencent)
        .transcribeBytes(pcm(), {
          signal: controller.signal,
          onProviderTask,
        })
        .catch((error) => {
          settled = true;
          return error;
        });
      await vi.waitFor(() => expect(onProviderTask).toHaveBeenCalledWith("42"));
      if (reason === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      release();
      expect(await result).toMatchObject({ code: reason === "cancel" ? "cancelled" : "timeout" });
      expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
    },
  );
  it("signs deterministic TC3 requests and awaits durable task storage before querying", async () => {
    reply({ Response: { Data: { TaskId: 42 } } });
    reply(tcComplete());
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onProviderTask = vi.fn(() => persisted);
    const result = createMediaAsrClient(tencent).transcribeBytes(pcm(), { onProviderTask });
    await vi.waitFor(() => expect(onProviderTask).toHaveBeenCalledWith("42"));
    expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
    release();
    expect(await result).toEqual({
      source: "asr",
      track: "original",
      language: null,
      cues: [{ startMs: 200, endMs: 2200, text: "测试识别。" }],
    });
    const [url, policy, body, headers] = vi.mocked(sendMediaJsonDocument).mock.calls[1]!;
    expect(url).toBe("https://asr.tencentcloudapi.com/");
    expect(body.toString()).toBe('{"TaskId":42}');
    expect(headers).toMatchObject({
      "X-TC-Action": "DescribeTaskStatus",
      "X-TC-Version": "2019-06-14",
      "X-TC-Region": "ap-shanghai",
      "X-TC-Timestamp": "1791007200",
    });
    // Calculated independently with Python hashlib/hmac from Tencent's published TC3 algorithm.
    expect(policy.credential?.authorization).toBe(
      "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2026-10-03/asr/tc3_request, SignedHeaders=content-type;host, Signature=8f3533557f2a377c1b7586dc482cd456a31393edc9961c7035bc3974672a6d02",
    );
    const input = JSON.parse(vi.mocked(sendMediaJsonDocument).mock.calls[0]![2].toString());
    expect(input).toMatchObject({
      EngineModelType: "16k_zh",
      ChannelNum: 1,
      ResTextFormat: 3,
      SourceType: 1,
      DataLen: pcm().length,
      Data: pcm().toString("base64"),
    });
  });

  it("uses the authorized URL above the 5 MiB inline limit", async () => {
    reply({ Response: { Data: { TaskId: 42 } } });
    reply(tcComplete());
    await createMediaAsrClient(tencent).transcribeBytes(pcm(200), { audioUrl: signedAudio });
    const input = JSON.parse(vi.mocked(sendMediaJsonDocument).mock.calls[0]![2].toString());
    expect(input).toMatchObject({ SourceType: 0, Url: signedAudio });
    expect(input).not.toHaveProperty("Data");
    vi.clearAllMocks();
    await expect(createMediaAsrClient(tencent).transcribeBytes(pcm(200))).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(sendMediaJsonDocument).not.toHaveBeenCalled();
  });

  it("never resubmits after a network outcome or task persistence failure", async () => {
    vi.mocked(sendMediaJsonDocument).mockRejectedValueOnce(new MediaHttpError("timeout"));
    await expect(createMediaAsrClient(tencent).transcribeBytes(pcm())).rejects.toMatchObject({
      code: "timeout",
    });
    expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    reply({ Response: { Data: { TaskId: 42 } } });
    await expect(
      createMediaAsrClient(tencent).transcribeBytes(pcm(), {
        onProviderTask: async () => {
          throw new Error(`Private ${signedAudio} ${tencent.secretKey}`);
        },
      }),
    ).rejects.toEqual(new AsrClientError("upstream_error"));
    expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
  });

  it.each([
    ["AuthFailure.SignatureFailure", "forbidden"],
    ["FailedOperation.UserHasNoFreeAmount", "unavailable"],
    ["FailedOperation.ServiceIsolate", "unavailable"],
    ["RequestLimitExceeded", "rate_limited"],
  ])("maps %s safely without retries", async (code, expected) => {
    reply({ Response: { Error: { Code: code, Message: `Private ${tencent.secretKey}` } } });
    await expect(createMediaAsrClient(tencent).transcribeBytes(pcm())).rejects.toEqual(
      new AsrClientError(expected as "forbidden"),
    );
    expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
  });

  it("resumes by querying and retries transient query failure without creating another task", async () => {
    vi.mocked(sendMediaJsonDocument).mockRejectedValueOnce(new MediaHttpError("rate_limited"));
    reply({ Response: { Data: { TaskId: 42, Status: 1 } } });
    reply(tcComplete());
    const operation = createMediaAsrClient(tencent).resume!("42", now, undefined, 3);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(operation).resolves.toMatchObject({ source: "asr" });
    expect(sendMediaJsonDocument).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(sendMediaJsonDocument).mock.calls)
      expect(call[3]).toMatchObject({ "X-TC-Action": "DescribeTaskStatus" });
  });

  it("rejects terminal task failure immediately without query retries", async () => {
    reply(tcComplete({ Status: 3, ErrorMsg: "Private secret" }));
    await expect(createMediaAsrClient(tencent).resume!("42", now)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
  });

  it.each([
    { TaskId: 43 },
    { ResultDetail: null },
    { AudioDuration: 6 },
    { ResultDetail: [{ StartMs: 0, EndMs: 6000, FinalSentence: "Invalid" }] },
    { ResultDetail: [{ StartMs: 1, EndMs: 1, FinalSentence: "Invalid" }] },
    { ResultDetail: [{ StartMs: 0, EndMs: 1, FinalSentence: "x".repeat(16_385) }] },
  ])("rejects malformed or mismatched completed data %#", async (fields) => {
    reply(tcComplete(fields));
    await expect(
      createMediaAsrClient(tencent).resume!("42", now, undefined, 3),
    ).rejects.toBeInstanceOf(AsrClientError);
  });

  it("rejects out-of-range uint64 IDs, invalid input and unsupported timestamp engines", async () => {
    reply({ Response: { Data: { TaskId: "18446744073709551616" } } });
    await expect(createMediaAsrClient(tencent).transcribeBytes(pcm())).rejects.toMatchObject({
      code: "invalid_response",
    });
    vi.clearAllMocks();
    await expect(
      createMediaAsrClient(tencent).transcribeBytes(Buffer.from("bad")),
    ).rejects.toMatchObject({ code: "invalid_file" });
    expect(sendMediaJsonDocument).not.toHaveBeenCalled();
    expect(() => createMediaAsrClient({ ...tencent, model: "16k_multi_lang" })).toThrow(
      AsrClientError,
    );
    expect(() => createMediaAsrClient({ ...tencent, secretId: "id\r\nHeader" })).toThrow(
      AsrClientError,
    );
    expect(() => createMediaAsrClient({ ...tencent, model: "16k_zh_en_2.0" })).not.toThrow();
  });

  it("preserves full uint64 task IDs without modifying quoted transcript text", async () => {
    const id = "18446744073709551615";
    vi.mocked(sendMediaJsonDocument).mockResolvedValueOnce({
      url: "",
      mimeType: "application/json",
      bytes: Buffer.from(`{"Response":{"Data":{"TaskId":${id}}}}`),
    });
    vi.mocked(sendMediaJsonDocument).mockResolvedValueOnce({
      url: "",
      mimeType: "application/json",
      bytes: Buffer.from(
        `{"Response":{"Data":{"TaskId":${id},"Status":2,"AudioDuration":3,"ResultDetail":[{"StartMs":0,"EndMs":2000,"FinalSentence":"Quoted 9007199254740993"}]}}}`,
      ),
    });
    const onProviderTask = vi.fn(async () => undefined);
    await expect(
      createMediaAsrClient(tencent).transcribeBytes(pcm(), { onProviderTask }),
    ).resolves.toMatchObject({ cues: [{ text: "Quoted 9007199254740993" }] });
    expect(onProviderTask).toHaveBeenCalledWith(id);
    expect(vi.mocked(sendMediaJsonDocument).mock.calls[1]![2].toString()).toBe(`{"TaskId":${id}}`);
  });

  it("rejects expired tasks before querying without resubmitting", async () => {
    await expect(
      createMediaAsrClient(tencent).resume!("42", new Date(now.getTime() - 24 * 60 * 60_000)),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(() => createMediaAsrClient(tencent).resume!("42", new Date("invalid"))).toThrow(
      AsrClientError,
    );
    expect(sendMediaJsonDocument).not.toHaveBeenCalled();
  });

  it("continues querying a known task across the UTC date boundary without resubmitting", async () => {
    vi.setSystemTime(new Date("2026-10-03T23:59:59Z"));
    reply({ Response: { Data: { TaskId: 42, Status: 0 } } });
    reply(tcComplete());
    const submittedAt = new Date();
    const operation = createMediaAsrClient(tencent).resume!("42", submittedAt).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(await operation).toMatchObject({ cues: [{ text: "测试识别。" }] });
    reply(tcComplete());
    await createMediaAsrClient(tencent).resume!("42", submittedAt);
    expect(sendMediaJsonDocument).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(sendMediaJsonDocument).mock.calls)
      expect(call[3]?.["X-TC-Action"]).toBe("DescribeTaskStatus");
  });

  it("stops local polling on cancellation without claiming to cancel the cloud task", async () => {
    reply({ Response: { Data: { TaskId: 42, Status: 0 } } });
    const controller = new AbortController();
    const operation = createMediaAsrClient(tencent).resume!("42", now, controller.signal);
    const assertion = expect(operation).rejects.toEqual(new AsrClientError("cancelled"));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
  });

  it("stops querying at the submitted task's remaining twenty-four-hour lifetime", async () => {
    vi.mocked(sendMediaJsonDocument).mockImplementation(async () => ({
      bytes: Buffer.from(
        JSON.stringify({
          Response: { Data: { TaskId: 42, Status: 0 } },
        }),
      ),
      url: "",
      mimeType: "application/json",
    }));
    const submittedAt = new Date(now.getTime() - 24 * 60 * 60_000 + 60_000);
    const operation = createMediaAsrClient(tencent).resume!("42", submittedAt);
    const assertion = expect(operation).rejects.toEqual(new AsrClientError("timeout"));
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    const queried = vi.mocked(sendMediaJsonDocument).mock.calls.length;
    expect(queried).toBeLessThanOrEqual(20);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMediaJsonDocument).toHaveBeenCalledTimes(queried);
  });
});

it.each(["tencent", "aliyun"] as const)(
  "continues %s polling beyond thirty minutes without resubmitting audio",
  async (provider) => {
    const config = provider === "tencent" ? tencent : aliyun;
    const submittedAt = new Date();
    const completeAt = submittedAt.getTime() + 31 * 60_000;
    if (provider === "tencent")
      vi.mocked(sendMediaJsonDocument).mockImplementation(async () => ({
        bytes: Buffer.from(
          JSON.stringify(
            Date.now() >= completeAt
              ? tcComplete()
              : { Response: { Data: { TaskId: 42, Status: 1 } } },
          ),
        ),
        url: "",
        mimeType: "application/json",
      }));
    else
      vi.mocked(readMediaDocument).mockImplementation(async (url) => ({
        bytes: Buffer.from(
          JSON.stringify(
            url.includes("/tasks/")
              ? Date.now() >= completeAt
                ? aliComplete()
                : { output: { task_id: "task-42", task_status: "RUNNING" } }
              : {
                  transcripts: [
                    {
                      channel_id: 0,
                      sentences: [{ begin_time: 0, end_time: 1000, text: "测试。" }],
                    },
                  ],
                },
          ),
        ),
        url,
        mimeType: "application/json",
      }));
    const operation = createMediaAsrClient(config).resume!(
      provider === "tencent" ? "42" : "task-42",
      submittedAt,
      undefined,
      3,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(await operation).toMatchObject({ source: "asr" });
    for (const call of vi.mocked(sendMediaJsonDocument).mock.calls)
      expect(call[3]?.["X-TC-Action"]).toBe("DescribeTaskStatus");
  },
);

describe("Aliyun Paraformer and compatible providers", () => {
  it("transcribes a two-hour verified file URL with preserved ending timestamps", async () => {
    reply({ output: { task_id: "task-42", task_status: "PENDING" } });
    reply(aliComplete(), false);
    reply(
      {
        transcripts: [
          {
            channel_id: 0,
            sentences: [{ begin_time: 7_199_000, end_time: 7_200_000, text: "Final sentence" }],
          },
        ],
      },
      false,
    );
    const result = await createMediaAsrClient(aliyun).transcribeUrl!(signedAudio, 7200);
    expect(result.cues[0]?.endMs).toBe(7_200_000);
    const input = JSON.parse(vi.mocked(sendMediaJsonDocument).mock.calls[0]![2].toString());
    expect(input.input.file_urls).toEqual([signedAudio]);
  });

  it("rejects a task at its twenty-four-hour host deadline without querying or submitting", async () => {
    await expect(
      createMediaAsrClient(aliyun).resume!("task-42", new Date(now.getTime() - 24 * 60 * 60_000)),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(readMediaDocument).not.toHaveBeenCalled();
    expect(sendMediaJsonDocument).not.toHaveBeenCalled();
  });

  it("submits the explicit model/URL, persists its task and downloads bounded results without credentials", async () => {
    reply({ output: { task_id: "task-42", task_status: "PENDING" } });
    reply(aliComplete(), false);
    reply(
      {
        transcripts: [
          {
            channel_id: 0,
            text: "你好。",
            sentences: [{ begin_time: 100, end_time: 2400, text: "你好。" }],
          },
        ],
      },
      false,
    );
    const onProviderTask = vi.fn(async () => {
      expect(readMediaDocument).not.toHaveBeenCalled();
    });
    expect(
      await createMediaAsrClient(aliyun).transcribeBytes(pcm(), {
        audioUrl: signedAudio,
        onProviderTask,
      }),
    ).toEqual({
      source: "asr",
      track: "original",
      language: null,
      cues: [{ startMs: 100, endMs: 2400, text: "你好。" }],
    });
    expect(onProviderTask).toHaveBeenCalledWith("task-42");
    const [url, policy, body, headers] = vi.mocked(sendMediaJsonDocument).mock.calls[0]!;
    expect(url).toBe("https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription");
    expect(JSON.parse(body.toString())).toMatchObject({
      model: "paraformer-v2",
      input: { file_urls: [signedAudio] },
      parameters: { channel_id: [0] },
    });
    expect(policy.credential).toEqual({
      origin: "https://dashscope.aliyuncs.com",
      authorization: "Bearer synthetic-key",
    });
    expect(headers).toEqual({ "X-DashScope-Async": "enable" });
    const resultPolicy = vi.mocked(readMediaDocument).mock.calls[1]![1];
    expect(resultPolicy.credential).toBeUndefined();
    expect(resultPolicy.maxRedirects).toBe(0);
  });

  it("requires audio URL and never resubmits after a persistence error", async () => {
    await expect(createMediaAsrClient(aliyun).transcribeBytes(pcm())).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(sendMediaJsonDocument).not.toHaveBeenCalled();
    reply({ output: { task_id: "task-42", task_status: "PENDING" } });
    await expect(
      createMediaAsrClient(aliyun).transcribeBytes(pcm(), {
        audioUrl: signedAudio,
        onProviderTask: async () => {
          throw new Error("Private");
        },
      }),
    ).rejects.toEqual(new AsrClientError("upstream_error"));
    expect(sendMediaJsonDocument).toHaveBeenCalledOnce();
    expect(readMediaDocument).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example.com/result.json",
    "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com@evil.example.com/result.json",
  ])("rejects untrusted result URL %s", async (url) => {
    reply(aliComplete(url), false);
    await expect(
      createMediaAsrClient(aliyun).resume!("task-42", now, undefined, 3),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(readMediaDocument).toHaveBeenCalledOnce();
    expect(sendMediaJsonDocument).not.toHaveBeenCalled();
  });

  it("checks subtask status and provider task identity", async () => {
    reply({ output: { task_id: "other-task", task_status: "PENDING" } }, false);
    await expect(createMediaAsrClient(aliyun).resume!("task-42", now)).rejects.toMatchObject({
      code: "invalid_response",
    });
    reply(
      {
        output: {
          task_id: "task-42",
          task_status: "SUCCEEDED",
          results: [{ subtask_status: "FAILED" }],
        },
      },
      false,
    );
    await expect(createMediaAsrClient(aliyun).resume!("task-42", now)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(sendMediaJsonDocument).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, missing timings and credentials before submission", async () => {
    vi.mocked(readMediaDocument).mockResolvedValueOnce({
      bytes: Buffer.from("not JSON"),
      url: "",
      mimeType: "application/json",
    });
    await expect(createMediaAsrClient(aliyun).resume!("task-42", now)).rejects.toMatchObject({
      code: "invalid_response",
    });
    reply(aliComplete(), false);
    reply({ transcripts: [{ channel_id: 0, text: "no times" }] }, false);
    await expect(createMediaAsrClient(aliyun).resume!("task-42", now)).rejects.toMatchObject({
      code: "timing_unavailable",
    });
    expect(() => createMediaAsrClient({ ...aliyun, apiKey: "\r\nsecret" })).toThrow(AsrClientError);
  });

  it("retains Groq and OpenAI multipart timestamp behavior without cloud task callbacks", async () => {
    const response = {
      url: "",
      mimeType: "application/json",
      bytes: Buffer.from(
        JSON.stringify({
          segments: [{ start: 0, end: 2, text: "Speech", avg_logprob: -1.2 }],
        }),
      ),
    };
    vi.mocked(sendMediaDocument).mockResolvedValueOnce(response);
    const onProviderTask = vi.fn();
    const groq = createMediaAsrClient({
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "key",
      model: "whisper-large-v3-turbo",
    });
    await expect(groq.transcribeBytes(pcm(), { onProviderTask })).resolves.toMatchObject({
      cues: [{ uncertain: true }],
    });
    expect(vi.mocked(sendMediaDocument).mock.calls[0]![0]).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions",
    );
    expect(onProviderTask).not.toHaveBeenCalled();
    expect(groq.resume).toBeUndefined();
    vi.mocked(sendMediaDocument).mockResolvedValueOnce(response);
    await createMediaAsrClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      model: "whisper-1",
    }).transcribeBytes(pcm());
    expect(vi.mocked(sendMediaDocument).mock.calls[1]![0]).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    );
  });
});
