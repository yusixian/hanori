import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { NsfwChecker } from "./nsfw-checker.js";

afterEach(() => vi.unstubAllGlobals());

describe("NsfwChecker", () => {
  it("persists real scores and reuses successful classification for the same bytes", async () => {
    const scores = { porn: 0.4, sexy: 0.2, hentai: 0, neutral: 0.4, drawing: 0 };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(scores));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const checker = new NsfwChecker({ apiUrl: "http://nsfw.test/" });
    const result = await checker.checkImageBytes(bytes);
    expect(result).toEqual({ status: "checked", isNsfw: true, scores });
    expect(await checker.checkImageBytes(bytes)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://nsfw.test/classify");
    expect(request.method).toBe("POST");
    const image = request.body.get("image") as Blob;
    expect(image.type).toBe("image/jpeg");
    expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format).toBe("jpeg");
  });

  it("does not cache failures so a recovered classifier can check the same image", async () => {
    const scores = { porn: 0, sexy: 0, hentai: 0, neutral: 1, drawing: 0 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(scores));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const checker = new NsfwChecker({ apiUrl: "http://nsfw.test" });
    expect(await checker.checkImageBytes(bytes)).toMatchObject({ status: "failed", scores: null });
    expect(await checker.checkImageBytes(bytes)).toEqual({
      status: "checked",
      isNsfw: false,
      scores,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect to a metadata endpoint before fetching it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new NsfwChecker({ apiUrl: "http://nsfw.test" }).checkImageUrl(
      "https://image.test/image.jpg",
    );
    expect(result).toMatchObject({ status: "failed", scores: null, isNsfw: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("covers an image when the classifier fails without inventing a safe score", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
              .jpeg()
              .toBuffer(),
            { headers: { "Content-Type": "image/jpeg" } },
          ),
        )
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 })),
    );
    const result = await new NsfwChecker({ apiUrl: "http://nsfw.test" }).checkImageUrl(
      "https://image.test/image.jpg",
    );
    expect(result).toMatchObject({ isNsfw: true, status: "failed", scores: null });
  });

  it("rejects an invalid successful classifier response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } })
              .jpeg()
              .toBuffer(),
            { headers: { "Content-Type": "image/jpeg" } },
          ),
        )
        .mockResolvedValueOnce(Response.json({})),
    );
    const result = await new NsfwChecker({ apiUrl: "http://nsfw.test" }).checkImageUrl(
      "https://image.test/image.jpg",
    );
    expect(result).toMatchObject({ isNsfw: true, status: "failed", scores: null });
  });
});
