import { randomUUID } from "node:crypto";
import type { Database } from "@cos-tool-bot/database";
import {
  boundedTranscriptPage,
  type MediaJobView,
  type MediaTranscriptionPort,
  type PluginContext,
  type TranscriptDocument,
} from "@cos-tool-bot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaJobError, MediaJobService } from "../media-jobs/service.js";
import { createMediaJobTools } from "./media-jobs.js";
import { bindPluginSession } from "./runtime.js";

const ID = randomUUID();
const URL = "https://www.bilibili.com/video/BV1xx411c7mD";
const view: MediaJobView = {
  id: ID,
  sourceUrl: URL,
  title: "Synthetic video",
  part: 1,
  durationSeconds: 60,
  status: "pending_confirmation",
  progress: 0,
  error: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  expiresAt: new Date(60_000).toISOString(),
  language: null,
  source: "asr",
  notification: "pending",
};
function document(
  count = 50,
  text = (index: number) => `Synthetic cue ${index}`,
): TranscriptDocument {
  return {
    source: "asr",
    track: "original",
    language: "en",
    cues: Array.from({ length: count }, (_, index) => ({
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      text: text(index),
      ...(index === 4 ? { uncertain: true } : {}),
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function context(): PluginContext {
  return {
    actor: {
      botId: randomUUID(),
      chatId: -123,
      userId: 456,
      threadId: 9,
      isAdmin: true,
      isPrivate: false,
      readOnly: false,
    },
    configuration: {},
    signal: new AbortController().signal,
  };
}

describe("host-bound media job tools", () => {
  let ctx: PluginContext;
  let port: MediaTranscriptionPort;
  let page: ReturnType<typeof vi.fn<typeof boundedTranscriptPage>>;
  const signal = () => new AbortController().signal;
  function tools() {
    return createMediaJobTools(ctx, port, page);
  }
  function tool(name: string) {
    return tools().find((tool) => tool.name === name)!;
  }
  function actor() {
    const { botId, chatId, userId, isAdmin, threadId } = ctx.actor;
    return { botId, chatId, userId, isAdmin, threadId };
  }
  beforeEach(() => {
    ctx = context();
    port = {
      create: vi.fn().mockResolvedValue(view),
      confirm: vi.fn().mockResolvedValue({ ...view, status: "queued" }),
      get: vi.fn().mockResolvedValue(view),
      cancel: vi.fn().mockResolvedValue(view),
      read: vi.fn().mockResolvedValue(document()),
    };
    page = vi.fn(boundedTranscriptPage);
  });

  it("provides no tools when the host has no Telegram user identity", () => {
    ctx = { ...ctx, actor: { ...ctx.actor, userId: undefined } };
    expect(tools()).toEqual([]);
  });

  it("binds creation to the host actor and passes the caller's cancellation signal", async () => {
    const caller = new AbortController();
    expect(await tool("transcribe_audio").execute({ sourceUrl: URL }, caller.signal)).toEqual({
      ...view,
      pending_confirmation: true,
    });
    expect(port.create).toHaveBeenCalledWith(actor(), { sourceUrl: URL }, expect.any(AbortSignal));
    const passed = vi.mocked(port.create).mock.calls[0]![2]!;
    expect(passed.aborted).toBe(false);
    caller.abort();
    expect(passed.aborted).toBe(true);
  });

  it.each(["botId", "chatId", "userId", "threadId", "isAdmin", "actor", "cookie", "asrApiKey"])(
    "rejects model-supplied %s before it reaches the host service",
    async (field) => {
      expect(
        await tool("transcribe_audio").execute({ sourceUrl: URL, [field]: "forged" }, signal()),
      ).toEqual({ error: "invalid_arguments" });
      expect(port.create).not.toHaveBeenCalled();
    },
  );

  it("allows an explicit subtitle override proposal but exposes no model confirmation tool", async () => {
    expect(
      await tool("transcribe_audio").execute({ sourceUrl: URL, forceAsr: true }, signal()),
    ).toMatchObject({ status: "pending_confirmation", pending_confirmation: true });
    expect(port.create).toHaveBeenCalledWith(
      actor(),
      { sourceUrl: URL, forceAsr: true },
      expect.any(AbortSignal),
    );
    expect(tools().map(({ name }) => name)).toEqual([
      "transcribe_audio",
      "get_transcription",
      "cancel_transcription",
      "read_transcription",
    ]);
    expect(port.confirm).not.toHaveBeenCalled();
    expect(tool("transcribe_audio").description).toContain("administrator explicitly asks");
  });

  it("reports an existing confirmed task without inventing another pending approval", async () => {
    vi.mocked(port.create).mockResolvedValue({ ...view, status: "queued" });
    expect(await tool("transcribe_audio").execute({ sourceUrl: URL }, signal())).toMatchObject({
      status: "queued",
      pending_confirmation: false,
    });
    expect(port.confirm).not.toHaveBeenCalled();
  });

  it("keeps creation admin-only and both mutations out of read-only host sessions", () => {
    for (const [isAdmin, readOnly, expected] of [
      [false, false, ["get_transcription", "cancel_transcription", "read_transcription"]],
      [true, true, ["get_transcription", "read_transcription"]],
    ] as const) {
      const session = bindPluginSession({
        pluginId: "hanori.bilibili",
        session: { tools: tools() },
        actor: { ...ctx.actor, isAdmin, readOnly },
        signal: ctx.signal,
        authorize: async () => undefined,
      });
      expect(
        session.tools.map(({ name }) => expected.find((suffix) => name.endsWith(suffix))),
      ).toEqual(expected);
      expect(session.tools.some(({ name }) => name.endsWith("transcribe_audio"))).toBe(false);
    }
  });

  it("rejects non-admin creation in the real service even if a raw tool is invoked directly", async () => {
    const configuration = vi.fn();
    const service = new MediaJobService({} as Database, {
      configuration,
      inspect: vi.fn(),
      execute: vi.fn(),
    });
    ctx = { ...ctx, actor: { ...ctx.actor, isAdmin: false } };
    port = service;
    expect(await tool("transcribe_audio").execute({ sourceUrl: URL }, signal())).toEqual({
      error: "forbidden",
    });
    expect(configuration).not.toHaveBeenCalled();
    await service.close();
  });

  it.each(["get_transcription", "cancel_transcription", "read_transcription"])(
    "binds %s to the same host actor and job ID",
    async (name) => {
      await tool(name).execute({ id: ID }, signal());
      const operation = name.startsWith("get")
        ? port.get
        : name.startsWith("cancel")
          ? port.cancel
          : port.read;
      expect(operation).toHaveBeenCalledWith(actor(), ID);
      expect(port.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { offset: -1 },
    { offset: 50_001 },
    { limit: 0 },
    { limit: 41 },
    { limit: 1.5 },
    { query: " " },
    { query: "x".repeat(201) },
    { userId: 999 },
  ])(
    "rejects invalid read pagination or identity fields before accessing the job: %j",
    async (input) => {
      expect(await tool("read_transcription").execute({ id: ID, ...input }, signal())).toEqual({
        error: "invalid_arguments",
      });
      expect(port.read).not.toHaveBeenCalled();
      expect(page).not.toHaveBeenCalled();
    },
  );

  it.each(["../input.wav", "https://provider.example/private", "invalid-uuid"])(
    "rejects arbitrary job paths %s",
    async (id) => {
      expect(await tool("get_transcription").execute({ id }, signal())).toEqual({
        error: "invalid_arguments",
      });
      expect(port.get).not.toHaveBeenCalled();
    },
  );

  it("returns at most 40 cues with stable ASR metadata, uncertainty and literal search offsets", async () => {
    const first = await tool("read_transcription").execute({ id: ID, limit: 40 }, signal());
    expect(first).toMatchObject({
      source: "asr",
      language: "en",
      total: 50,
      nextOffset: 40,
      hasMore: true,
      cues: expect.arrayContaining([expect.objectContaining({ cueIndex: 4, uncertain: true })]),
    });
    expect((first as ReturnType<typeof boundedTranscriptPage>).cues).toHaveLength(40);
    expect(
      await tool("read_transcription").execute({ id: ID, offset: 40, limit: 40 }, signal()),
    ).toMatchObject({
      hasMore: false,
      nextOffset: null,
      cues: expect.arrayContaining([expect.objectContaining({ cueIndex: 49 })]),
    });
    expect(
      await tool("read_transcription").execute({ id: ID, query: " CUE 4 ", limit: 2 }, signal()),
    ).toMatchObject({ total: 11, nextOffset: 2, cues: [{ cueIndex: 4 }, { cueIndex: 40 }] });
    expect(page).toHaveBeenLastCalledWith(expect.anything(), {
      query: "CUE 4",
      offset: 0,
      limit: 2,
    });
  });

  it("reads a bounded long-transcript page beyond cue 10,000 in the host actor scope", async () => {
    vi.mocked(port.read).mockResolvedValue(document(10_050));
    const result = (await tool("read_transcription").execute(
      { id: ID, offset: 10_001, limit: 40 },
      signal(),
    )) as ReturnType<typeof boundedTranscriptPage>;
    expect(result).toMatchObject({
      source: "asr",
      total: 10_050,
      nextOffset: 10_041,
      hasMore: true,
    });
    expect(result.cues).toHaveLength(40);
    expect(result.cues[0]).toMatchObject({ cueIndex: 10_001, text: "Synthetic cue 10001" });
    expect(result.cues.at(-1)?.cueIndex).toBe(10_040);
    expect(result.cues.reduce((sum, cue) => sum + cue.text.length, 0)).toBeLessThanOrEqual(4000);
    expect(port.read).toHaveBeenCalledWith(actor(), ID);
    vi.mocked(port.read).mockRejectedValueOnce(new MediaJobError("forbidden"));
    expect(await tool("read_transcription").execute({ id: ID, offset: 10_001 }, signal())).toEqual({
      error: "forbidden",
    });
    expect(page).toHaveBeenCalledOnce();
  });

  it("preserves the 4000-character read budget and deferred cue offset", async () => {
    vi.mocked(port.read).mockResolvedValue(document(3, () => "x".repeat(3000)));
    expect(await tool("read_transcription").execute({ id: ID }, signal())).toMatchObject({
      cues: [expect.objectContaining({ text: "x".repeat(3000) })],
      nextOffset: 1,
      hasMore: true,
    });
  });

  it.each(["context", "caller"])(
    "skips service calls when the %s signal is already cancelled",
    async (source) => {
      const cancelled = new AbortController();
      cancelled.abort();
      if (source === "context") ctx = { ...ctx, signal: cancelled.signal };
      expect(
        await tool("get_transcription").execute(
          { id: ID },
          source === "caller" ? cancelled.signal : signal(),
        ),
      ).toEqual({ error: "cancelled" });
      expect(port.get).not.toHaveBeenCalled();
    },
  );

  it("discards a late read result after cancellation and propagates cancellation into pending creation", async () => {
    const pendingRead = deferred<TranscriptDocument>();
    vi.mocked(port.read).mockReturnValue(pendingRead.promise);
    const caller = new AbortController();
    const reading = tool("read_transcription").execute({ id: ID }, caller.signal);
    caller.abort();
    pendingRead.resolve(document());
    expect(await reading).toEqual({ error: "cancelled" });
    const pendingCreate = deferred<MediaJobView>();
    vi.mocked(port.create).mockReturnValue(pendingCreate.promise);
    const host = new AbortController();
    ctx = { ...ctx, signal: host.signal };
    const creating = tool("transcribe_audio").execute({ sourceUrl: URL }, signal());
    host.abort();
    expect(vi.mocked(port.create).mock.calls[0]![2]!.aborted).toBe(true);
    pendingCreate.resolve(view);
    expect(await creating).toEqual({ error: "cancelled" });
  });

  it("returns known safe errors and hides unexpected credentials or provider diagnostics", async () => {
    vi.mocked(port.get).mockRejectedValueOnce(new MediaJobError("not_found"));
    expect(await tool("get_transcription").execute({ id: ID }, signal())).toEqual({
      error: "not_found",
    });
    vi.mocked(port.get).mockRejectedValueOnce(
      new Error("Authorization=synthetic-secret https://private-provider.invalid"),
    );
    expect(await tool("get_transcription").execute({ id: ID }, signal())).toEqual({
      error: "media_job_failed",
    });
  });
});
