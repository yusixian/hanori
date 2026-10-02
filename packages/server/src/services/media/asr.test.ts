import { link, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsrClientError, createAsrClient } from "./asr.js";
import { MediaHttpError, sendMediaDocument } from "./http.js";

vi.mock("./http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http.js")>()),
  sendMediaDocument: vi.fn(),
}));

const config = {
  baseUrl: "https://speech.example.com/v1",
  apiKey: "synthetic-secret",
  model: "whisper-1",
  language: "zh",
};
const wav = Buffer.alloc(44);
wav.write("RIFF", 0);
wav.writeUInt32LE(36, 4);
wav.write("WAVE", 8);
let directory: string;
let path: string;

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "media-asr-test-"));
  path = join(directory, "private-filename-with-owner-info.wav");
  await writeFile(path, wav);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function reply(value: unknown) {
  vi.mocked(sendMediaDocument).mockResolvedValueOnce({
    url: "https://speech.example.com/v1/audio/transcriptions",
    mimeType: "application/json",
    bytes: Buffer.from(JSON.stringify(value)),
  });
}

describe("ASR segment transcription", () => {
  it("uploads bounded multipart WAV with a generic filename to exactly the configured model/provider", async () => {
    reply({
      language: "english",
      duration: 3,
      segments: [
        { start: 0.5, end: 1.25, text: "Synthetic speech", avg_logprob: -0.2, no_speech_prob: 0.1 },
        {
          start: 2,
          end: 3,
          text: "Uncertain synthetic speech",
          avg_logprob: -1.2,
          no_speech_prob: 0.2,
          speaker: "untrusted speaker claim",
        },
      ],
    });
    const document = await createAsrClient(config).transcribe(path);
    expect(document).toEqual({
      source: "asr",
      track: "original",
      language: "english",
      cues: [
        { startMs: 500, endMs: 1250, text: "Synthetic speech" },
        { startMs: 2000, endMs: 3000, text: "Uncertain synthetic speech", uncertain: true },
      ],
    });
    expect(sendMediaDocument).toHaveBeenCalledTimes(1);
    const [url, policy, body] = vi.mocked(sendMediaDocument).mock.calls[0]!;
    expect(url).toBe("https://speech.example.com/v1/audio/transcriptions");
    expect(policy).toMatchObject({
      allowedHosts: ["speech.example.com"],
      mimeTypes: ["application/json"],
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 180_000,
      credential: {
        origin: "https://speech.example.com",
        authorization: "Bearer synthetic-secret",
      },
    });
    expect(body.contentType).toMatch(/^multipart\/form-data; boundary=hanori_[a-f0-9]{32}$/);
    const encoded = body.bytes.toString("utf8");
    expect(encoded).toContain('name="file"; filename="audio.wav"');
    expect(encoded).toContain('name="model"\r\n\r\nwhisper-1');
    expect(encoded).toContain('name="response_format"\r\n\r\nverbose_json');
    expect(encoded).toContain('name="timestamp_granularities[]"\r\n\r\nsegment');
    expect(encoded).toContain('name="language"\r\n\r\nzh');
    expect(encoded).not.toContain("private-filename");
    expect(encoded).not.toContain("synthetic-secret");
    expect(body.bytes.includes(wav)).toBe(true);
    expect(body.bytes.length).toBeLessThan(21 * 1024 * 1024);
    expect(JSON.stringify(document)).not.toContain("speaker");
  });

  it("uses configured language only when the provider does not report one", async () => {
    reply({ segments: [{ start: 0, end: 1, text: "Synthetic speech", no_speech_prob: 0.99 }] });
    await expect(createAsrClient(config).transcribe(path)).resolves.toEqual({
      source: "asr",
      track: "original",
      language: "zh",
      cues: [{ startMs: 0, endMs: 1000, text: "Synthetic speech" }],
    });
    reply({ segments: [] });
    await expect(
      createAsrClient({ ...config, language: undefined }).transcribe(path),
    ).resolves.toEqual({ source: "asr", track: "original", language: null, cues: [] });
  });

  it("validates WAV magic as exact bytes and rejects invalid UTF-8 JSON", async () => {
    const fake = Buffer.from(wav);
    for (let index = 0; index < 4; index++) fake[index] = fake[index]! | 0x80;
    await writeFile(path, fake);
    await expect(createAsrClient(config).transcribe(path)).rejects.toMatchObject({
      code: "invalid_file",
    });
    expect(sendMediaDocument).not.toHaveBeenCalled();
    await writeFile(path, wav);
    vi.mocked(sendMediaDocument).mockResolvedValueOnce({
      url: "ignored",
      mimeType: "application/json",
      bytes: Buffer.concat([
        Buffer.from('{"segments":[],"text":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
    });
    await expect(createAsrClient(config).transcribe(path)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    { baseUrl: "http://speech.example.com/v1" },
    { baseUrl: "https://speech.example.com:443/v1" },
    { baseUrl: "https://speech.example.com:8443/v1" },
    { baseUrl: "https://secret@speech.example.com/v1" },
    { baseUrl: "https://speech.example.com/v1?token=secret" },
    { baseUrl: "https://speech.example.com/v1#fragment" },
    { baseUrl: "https://speech.example.com/x/../v1" },
    { baseUrl: "https://127.0.0.1/v1" },
    { baseUrl: "https://speech.example.com\\@evil.invalid/v1" },
    { apiKey: "" },
    { apiKey: "secret\r\nHost: evil.invalid" },
    { model: "whisper-1\r\nmodel=other" },
    { model: "x".repeat(65) },
    { language: "x".repeat(65) },
  ])("rejects unsafe configuration without echoing it %#", (value) => {
    expect(() => createAsrClient({ ...config, ...value })).toThrow(
      new AsrClientError("invalid_configuration"),
    );
    expect(sendMediaDocument).not.toHaveBeenCalled();
  });

  it.each(["symlink", "hardlink", "directory", "invalid_magic", "truncated", "too_large"] as const)(
    "rejects unsafe WAV %s before upload",
    async (kind) => {
      let input = path;
      if (kind === "symlink") {
        input = join(directory, "symlink.wav");
        await symlink(path, input);
      }
      if (kind === "hardlink") {
        input = join(directory, "hardlink.wav");
        await link(path, input);
      }
      if (kind === "directory") input = directory;
      if (kind === "invalid_magic") await writeFile(path, Buffer.alloc(44));
      if (kind === "truncated") await writeFile(path, wav.subarray(0, 10));
      if (kind === "too_large") {
        const file = await open(path, "r+");
        try {
          await file.truncate(20 * 1024 * 1024 + 1);
        } finally {
          await file.close();
        }
      }
      await expect(createAsrClient(config).transcribe(input)).rejects.toMatchObject({
        code: kind === "too_large" ? "too_large" : "invalid_file",
      });
      expect(sendMediaDocument).not.toHaveBeenCalled();
    },
  );

  it.each([
    { text: "Synthetic plain text without timestamps" },
    { text: "Synthetic plain text", segments: [] },
  ])("rejects text-only responses instead of inventing timestamps %#", async (data) => {
    reply(data);
    await expect(createAsrClient(config).transcribe(path)).rejects.toMatchObject({
      code: "timing_unavailable",
    });
    expect(sendMediaDocument).toHaveBeenCalledTimes(1);
  });

  it.each([
    { start: -1, end: 1, text: "Synthetic" },
    { start: 0, end: 601, text: "Synthetic" },
    { start: 1, end: 1, text: "Synthetic" },
    { start: 0, end: 0.0001, text: "Synthetic" },
    { start: "0", end: 1, text: "Synthetic" },
    { start: 0, end: 1, text: "x".repeat(16_385) },
    { start: 0, end: 1, text: "Synthetic", no_speech_prob: 1.5 },
    { start: 0, end: 1, text: "Synthetic", avg_logprob: 1 },
    { start: 0, end: 1, text: "Synthetic", avg_logprob: "low" },
  ])("rejects malformed segment intervals/text/confidence %#", async (segment) => {
    reply({ segments: [segment] });
    await expect(createAsrClient(config).transcribe(path)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    {
      segments: [
        { start: 2, end: 3, text: "Synthetic" },
        { start: 1, end: 2, text: "Synthetic" },
      ],
    },
    {
      segments: [
        { start: 0, end: 3, text: "Synthetic" },
        { start: 1, end: 2, text: "Synthetic" },
      ],
    },
    { segments: Array.from({ length: 10_001 }, () => ({ start: 0, end: 1, text: "" })) },
    {
      segments: Array.from({ length: 50 }, () => ({ start: 0, end: 1, text: "x".repeat(10_001) })),
    },
    { language: "unsupported language string", segments: [] },
    { duration: 601, segments: [] },
    { segments: "malformed" },
  ])("bounds response collections and ordering %#", async (data) => {
    reply(data);
    await expect(createAsrClient(config).transcribe(path)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("sanitizes arbitrary provider messages and classifies bounded HTTP errors without retries", async () => {
    vi.mocked(sendMediaDocument).mockRejectedValueOnce(
      new Error("Bearer secret https://private.invalid/?token=secret"),
    );
    await expect(createAsrClient(config).transcribe(path)).rejects.toEqual(
      new AsrClientError("upstream_error"),
    );
    vi.mocked(sendMediaDocument).mockRejectedValueOnce(new MediaHttpError("forbidden"));
    await expect(createAsrClient(config).transcribe(path)).rejects.toEqual(
      new AsrClientError("forbidden"),
    );
    vi.mocked(sendMediaDocument).mockRejectedValueOnce(new MediaHttpError("invalid_content"));
    await expect(createAsrClient(config).transcribe(path)).rejects.toEqual(
      new AsrClientError("invalid_response"),
    );
    expect(sendMediaDocument).toHaveBeenCalledTimes(3);
  });

  it("propagates cancellation before file read and after late provider results with safe labels", async () => {
    const controller = new AbortController();
    vi.mocked(sendMediaDocument).mockImplementationOnce(async () => {
      controller.abort(new Error("private cancellation detail"));
      return {
        url: "ignored",
        mimeType: "application/json",
        bytes: Buffer.from(JSON.stringify({ segments: [] })),
      };
    });
    const client = createAsrClient(config);
    await expect(client.transcribe(path, controller.signal)).rejects.toEqual(
      new AsrClientError("cancelled"),
    );
    await expect(client.transcribe(path, controller.signal)).rejects.toEqual(
      new AsrClientError("cancelled"),
    );
    expect(sendMediaDocument).toHaveBeenCalledTimes(1);
  });

  it("limits the entire file-read/upload operation to180s", async () => {
    vi.useFakeTimers();
    try {
      let dispatched!: () => void;
      const started = new Promise<void>((resolve) => {
        dispatched = resolve;
      });
      vi.mocked(sendMediaDocument).mockImplementationOnce(
        (_input, policy) =>
          new Promise((_resolve, reject) => {
            policy.signal!.addEventListener("abort", () => reject(policy.signal!.reason), {
              once: true,
            });
            dispatched();
          }),
      );
      const pending = createAsrClient(config).transcribe(path);
      const assertion = expect(pending).rejects.toEqual(new AsrClientError("timeout"));
      await started;
      await vi.advanceTimersByTimeAsync(180_001);
      await assertion;
      expect(sendMediaDocument).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
