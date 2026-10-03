import { randomUUID } from "node:crypto";
import type { PluginContext, VideoDownloadPort, VideoDownloadView } from "@cos-tool-bot/shared";
import { describe, expect, it, vi } from "vitest";
import { VideoDownloadError } from "../video-downloads/contracts.js";
import { createVideoDownloadTools } from "./video-downloads.js";

function fixture() {
  const stop = new AbortController();
  const context: PluginContext = {
    actor: {
      botId: "synthetic-bot",
      chatId: -42,
      userId: 7,
      threadId: 9,
      isAdmin: true,
      isPrivate: false,
      readOnly: false,
    },
    configuration: { cookie: "SESSDATA=synthetic-secret", downloadEnabled: true },
    signal: stop.signal,
  };
  const view: VideoDownloadView = {
    id: randomUUID(),
    sourceUrl: "https://www.bilibili.com/video/BV1abcdefghj",
    title: "Synthetic video",
    durationSeconds: 60,
    status: "queued",
    error: null,
    bytes: null,
    messageId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cacheExpiresAt: null,
  };
  const port: VideoDownloadPort = {
    create: vi.fn().mockResolvedValue(view),
    get: vi.fn().mockResolvedValue(view),
    cancel: vi.fn().mockResolvedValue(view),
  };
  const tools = createVideoDownloadTools(context, port);
  const call = (name: string, input: unknown, signal = new AbortController().signal) =>
    tools.find((tool) => tool.name === name)!.execute(input, signal);
  return { stop, context, view, port, tools, call };
}

describe("host-bound video download tools", () => {
  it("binds bot, chat, user and topic in the host and declares administrator-only effects", async () => {
    const { tools, port, call, view } = fixture();
    expect(tools.map(({ name, effect, access }) => ({ name, effect, access }))).toEqual([
      { name: "download_video", effect: "mutating", access: "admin" },
      { name: "get_video_download", effect: "read_only", access: "admin" },
      { name: "cancel_video_download", effect: "mutating", access: "admin" },
    ]);
    expect(JSON.stringify(tools)).not.toContain("synthetic-secret");
    expect(port.create).not.toHaveBeenCalled();
    await expect(call("download_video", { sourceUrl: view.sourceUrl })).resolves.toEqual(view);
    expect(port.create).toHaveBeenCalledWith(
      { botId: "synthetic-bot", chatId: -42, userId: 7, threadId: 9, isAdmin: true },
      { sourceUrl: view.sourceUrl },
      expect.any(AbortSignal),
    );
    await call("get_video_download", { id: view.id });
    await call("cancel_video_download", { id: view.id });
    expect(port.get).toHaveBeenCalledWith(expect.objectContaining({ threadId: 9 }), view.id);
    expect(port.cancel).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }), view.id);
  });

  it("requires host user identity", () => {
    const { context, port } = fixture();
    expect(
      createVideoDownloadTools(
        { ...context, actor: { ...context.actor, userId: undefined } },
        port,
      ),
    ).toEqual([]);
  });

  it.each([
    { sourceUrl: " " },
    { sourceUrl: "x".repeat(2049) },
    { sourceUrl: "https://www.bilibili.com/video/BV1abcdefghj", chatId: 99 },
    { sourceUrl: "https://www.bilibili.com/video/BV1abcdefghj", outputPath: "/private/output.mp4" },
    { sourceUrl: "https://www.bilibili.com/video/BV1abcdefghj", cookie: "secret" },
  ])("rejects model destination, path, credential and malformed arguments: %j", async (input) => {
    const { call, port } = fixture();
    await expect(call("download_video", input)).resolves.toEqual({ error: "invalid_arguments" });
    expect(port.create).not.toHaveBeenCalled();
  });

  it("validates job IDs and rejects extra retrieval arguments", async () => {
    const { call, port, view } = fixture();
    await expect(call("get_video_download", { id: "invalid" })).resolves.toEqual({
      error: "invalid_arguments",
    });
    await expect(call("cancel_video_download", { id: view.id, chatId: 99 })).resolves.toEqual({
      error: "invalid_arguments",
    });
    expect(port.get).not.toHaveBeenCalled();
    expect(port.cancel).not.toHaveBeenCalled();
  });

  it("uses turn and call signals for creation validation without cancelling accepted background jobs", async () => {
    const { call, port, view, stop } = fixture();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      call("download_video", { sourceUrl: view.sourceUrl }, cancellation.signal),
    ).resolves.toEqual({ error: "cancelled" });
    expect(port.create).not.toHaveBeenCalled();
    await call("download_video", { sourceUrl: view.sourceUrl });
    stop.abort();
    expect(port.cancel).not.toHaveBeenCalled();
    await expect(call("download_video", { sourceUrl: view.sourceUrl })).resolves.toEqual({
      error: "cancelled",
    });
    expect(port.create).toHaveBeenCalledTimes(1);
  });

  it("keeps an accepted creation result even when the validation signal closes at completion", async () => {
    const { call, port, view, stop } = fixture();
    vi.mocked(port.create).mockImplementationOnce(async () => {
      stop.abort();
      return view;
    });
    await expect(call("download_video", { sourceUrl: view.sourceUrl })).resolves.toEqual(view);
    expect(port.cancel).not.toHaveBeenCalled();
  });

  it("returns the actual sending status rather than claiming cancellation succeeded", async () => {
    const { call, port, view } = fixture();
    vi.mocked(port.cancel).mockResolvedValueOnce({ ...view, status: "sending" });
    await expect(call("cancel_video_download", { id: view.id })).resolves.toMatchObject({
      status: "sending",
    });
  });

  it("exposes safe service codes and hides raw failures and abort reasons", async () => {
    const { call, port, view } = fixture();
    vi.mocked(port.create).mockRejectedValueOnce(new VideoDownloadError("quota_exceeded"));
    await expect(call("download_video", { sourceUrl: view.sourceUrl })).resolves.toEqual({
      error: "quota_exceeded",
    });
    vi.mocked(port.get).mockRejectedValueOnce(
      new Error("Cookie=secret https://private.invalid/?token=secret"),
    );
    await expect(call("get_video_download", { id: view.id })).resolves.toEqual({
      error: "video_download_failed",
    });
    const cancellation = new AbortController();
    vi.mocked(port.create).mockImplementationOnce(async () => {
      cancellation.abort(new Error("secret"));
      throw cancellation.signal.reason;
    });
    await expect(
      call("download_video", { sourceUrl: view.sourceUrl }, cancellation.signal),
    ).resolves.toEqual({ error: "cancelled" });
  });
});
