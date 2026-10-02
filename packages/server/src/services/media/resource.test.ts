import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMediaUrl } from "./http.js";
import { resolveBilibiliResource, resolveNeteaseResource } from "./resource.js";

vi.mock("./http.js", () => ({ resolveMediaUrl: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("platform resource resolution", () => {
  it("normalizes a canonical identity without fetching or claiming access", async () => {
    await expect(resolveBilibiliResource("av42")).resolves.toMatchObject({
      kind: "canonical",
      platform: "bilibili",
      id: 42,
    });
    await expect(
      resolveNeteaseResource("https://music.163.com/#/song?id=42"),
    ).resolves.toMatchObject({
      kind: "canonical",
      platform: "netease",
      id: 42,
    });
    expect(resolveMediaUrl).not.toHaveBeenCalled();
  });

  it("resolves a NetEase short link with a fixed policy and revalidates its resource", async () => {
    vi.mocked(resolveMediaUrl).mockResolvedValue("https://y.music.163.com/m/playlist?id=42");
    const controller = new AbortController();
    await expect(
      resolveNeteaseResource("https://163cn.tv/synthetic", controller.signal),
    ).resolves.toEqual({
      kind: "canonical",
      platform: "netease",
      resourceType: "playlist",
      id: 42,
      canonicalUrl: "https://music.163.com/playlist?id=42",
    });
    expect(resolveMediaUrl).toHaveBeenCalledWith("https://163cn.tv/synthetic", {
      allowedHosts: ["163cn.tv", "music.163.com", "y.music.163.com"],
      signal: controller.signal,
    });
  });

  it("preserves the destination part unless the caller's short URL selects a part", async () => {
    vi.mocked(resolveMediaUrl).mockResolvedValue("https://www.bilibili.com/video/av42?p=3");
    await expect(resolveBilibiliResource("https://b23.tv/synthetic")).resolves.toMatchObject({
      part: 3,
      canonicalUrl: "https://www.bilibili.com/video/av42?p=3",
    });
    await expect(resolveBilibiliResource("https://b23.tv/synthetic?p=2")).resolves.toMatchObject({
      part: 2,
      canonicalUrl: "https://www.bilibili.com/video/av42?p=2",
    });
    expect(resolveMediaUrl).toHaveBeenLastCalledWith("https://b23.tv/synthetic?p=2", {
      allowedHosts: ["b23.tv", "bilibili.com", "www.bilibili.com", "m.bilibili.com"],
      signal: undefined,
    });
  });

  it.each([
    "https://www.bilibili.com/",
    "https://b23.tv/still-short",
    "https://www.bilibili.com/video/av42?p=2&p=3",
    "https://evil.test/video/av42",
  ])(
    "rejects a short link destination that is not a canonical resource: %s",
    async (destination) => {
      vi.mocked(resolveMediaUrl).mockResolvedValue(destination);
      await expect(resolveBilibiliResource("https://b23.tv/synthetic")).rejects.toMatchObject({
        code: "invalid_media_link",
      });
    },
  );

  it("rejects unresolved or cross-platform NetEase destinations", async () => {
    for (const destination of [
      "https://163cn.tv/again",
      "https://b23.tv/other",
      "https://music.163.com/login",
    ]) {
      vi.mocked(resolveMediaUrl).mockResolvedValue(destination);
      await expect(resolveNeteaseResource("https://163cn.tv/synthetic")).rejects.toMatchObject({
        code: "invalid_media_link",
      });
    }
  });

  it("propagates cancellation before dispatch and rejects a late resolver result", async () => {
    const controller = new AbortController();
    const reason = new Error("Cancelled");
    vi.mocked(resolveMediaUrl).mockImplementation(async () => {
      controller.abort(reason);
      return "https://www.bilibili.com/video/av42";
    });
    await expect(
      resolveBilibiliResource("https://b23.tv/synthetic", controller.signal),
    ).rejects.toBe(reason);
    await expect(resolveBilibiliResource("av42", controller.signal)).rejects.toBe(reason);
    await expect(
      resolveNeteaseResource("https://163cn.tv/synthetic", controller.signal),
    ).rejects.toBe(reason);
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
  });
});
