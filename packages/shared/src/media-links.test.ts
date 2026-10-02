import { describe, expect, it, vi } from "vitest";
import {
  MAX_BILIBILI_PART,
  MAX_MEDIA_LINK_LENGTH,
  MAX_MEDIA_RESOURCE_ID,
  MediaLinkParseError,
  parseBilibiliResource,
  parseNeteaseResource,
} from "./media-links.js";

const BV = "BV1B7411m7LV";
const NETEASE = "https://music.163.com/song?id=385925";
const BILIBILI = `https://www.bilibili.com/video/${BV}`;

function invalid(parser: (input: string) => unknown, input: string): void {
  expect(() => parser(input)).toThrow(MediaLinkParseError);
  try {
    parser(input);
  } catch (error) {
    expect(error).toMatchObject({
      name: "MediaLinkParseError",
      code: "invalid_media_link",
      message: "Invalid or unsupported media resource link",
    });
    expect(String(error)).not.toContain(input);
    expect((error as Error).cause).toBeUndefined();
  }
}

describe("Netease resource links", () => {
  it("canonicalizes the observed web, hash and mobile route spellings for all resource types", () => {
    const resources = [
      { resourceType: "song", id: 385925 },
      { resourceType: "album", id: 2504373 },
      { resourceType: "playlist", id: 1978921795 },
    ];
    for (const { resourceType, id } of resources) {
      for (const host of ["music.163.com", "y.music.163.com"]) {
        for (const prefix of ["/", "/m/", "/#/", "/#/m/"]) {
          expect(
            parseNeteaseResource(
              `https://${host}${prefix}${resourceType}?id=${id}&utm_source=fixture`,
            ),
          ).toEqual({
            kind: "canonical",
            platform: "netease",
            resourceType,
            id,
            canonicalUrl: `https://music.163.com/${resourceType}?id=${id}`,
          });
        }
      }
    }
  });

  it("normalizes safe numeric IDs, encoded parameter values and default HTTPS authority", () => {
    expect(
      parseNeteaseResource(" https://MUSIC.163.COM:443/song/?%69d=%30%30%31#?thirdfrom=fixture "),
    ).toMatchObject({ id: 1, canonicalUrl: "https://music.163.com/song?id=1" });
    expect(
      parseNeteaseResource(`https://music.163.com/album?id=${MAX_MEDIA_RESOURCE_ID}`),
    ).toMatchObject({ id: MAX_MEDIA_RESOURCE_ID });
  });

  it("returns an explicit safe short-link target without forwarding query values", () => {
    expect(
      parseNeteaseResource(
        "https://163cn.tv/AbC_12-x/?utm_source=fixture&next=https%3A%2F%2Fevil.example",
      ),
    ).toEqual({
      kind: "short_link",
      platform: "netease",
      url: "https://163cn.tv/AbC_12-x",
      needsResolution: true,
    });
  });

  it.each([
    "https://music.163.com/",
    "https://music.163.com/user?id=1",
    "https://music.163.com/song/1",
    "https://music.163.com/song",
    "https://music.163.com/song?id=",
    "https://music.163.com/song?id=0",
    "https://music.163.com/song?id=-1",
    "https://music.163.com/song?id=1.5",
    "https://music.163.com/song?id=1e3",
    "https://music.163.com/song?id=%2B1",
    "https://music.163.com/song?id=%201",
    "https://music.163.com/song?id=9007199254740992",
    "https://music.163.com/song?id=99999999999999999999999999",
    "https://music.163.com/song?id=1&id=1",
    "https://music.163.com/song?id=1&%69d=2",
    "https://music.163.com/song?next=https%3A%2F%2Fmusic.163.com%2Fsong%3Fid%3D1",
    "https://music.163.com/song?id=1#/album?id=2",
    "https://music.163.com/song#/song?id=1",
    "https://music.163.com/?id=1#/song?id=1",
    "https://music.163.com/#/song?id=1&id=2",
    "https://music.163.com/#/song?id=1#/album?id=2",
    "https://music.163.com/#/user?id=1",
    "https://music.163.com/song?id=1#id=2",
    "https://163cn.tv/",
    "https://163cn.tv/a/b",
    "https://163cn.tv/a?id=1",
    "https://163cn.tv/a?p=2",
    "https://163cn.tv/a#fragment",
    "https://163cn.tv/%2Fmusic.163.com",
    "385925",
  ])("rejects unsupported, ambiguous or unsafe identity %s", (input) =>
    invalid(parseNeteaseResource, input),
  );

  it("never chooses an identity or host hidden inside a query value", () => {
    invalid(
      parseNeteaseResource,
      "https://evil.example/?next=https://music.163.com/song?id=385925",
    );
    expect(
      parseNeteaseResource(`${NETEASE}&next=https%3A%2F%2Fevil.example%2Fsong%3Fid%3D999`),
    ).toMatchObject({ id: 385925, canonicalUrl: NETEASE });
  });
});

describe("Bilibili resource links", () => {
  it("preserves case-sensitive BV IDs for bare IDs and supported video hosts", () => {
    const expected = {
      kind: "canonical",
      platform: "bilibili",
      resourceType: "video",
      idType: "bv",
      id: BV,
      part: 1,
      canonicalUrl: BILIBILI,
    };
    expect(parseBilibiliResource(BV)).toEqual(expected);
    for (const host of ["bilibili.com", "www.bilibili.com", "m.bilibili.com"])
      expect(
        parseBilibiliResource(`https://${host}/video/${BV}/?share_source=fixture#t=10`),
      ).toEqual(expected);
    expect(parseBilibiliResource("BV1b7411m7LV")).toMatchObject({
      id: "BV1b7411m7LV",
      canonicalUrl: "https://www.bilibili.com/video/BV1b7411m7LV",
    });
  });

  it("normalizes av prefixes and positive numeric IDs without converting them into BV IDs", () => {
    for (const input of ["av00170001", "AV170001", "https://www.bilibili.com/video/Av170001/"])
      expect(parseBilibiliResource(input)).toEqual({
        kind: "canonical",
        platform: "bilibili",
        resourceType: "video",
        idType: "av",
        id: 170001,
        part: 1,
        canonicalUrl: "https://www.bilibili.com/video/av170001",
      });
    expect(parseBilibiliResource(`av${MAX_MEDIA_RESOURCE_ID}`)).toMatchObject({
      id: MAX_MEDIA_RESOURCE_ID,
    });
  });

  it("preserves bounded selected parts and drops unrelated share parameters", () => {
    expect(parseBilibiliResource(`${BILIBILI}/?share_source=fixture&p=%30%32`)).toMatchObject({
      part: 2,
      canonicalUrl: `${BILIBILI}?p=2`,
    });
    expect(parseBilibiliResource(`${BILIBILI}?p=1`)).toMatchObject({
      part: 1,
      canonicalUrl: BILIBILI,
    });
    expect(parseBilibiliResource(`${BILIBILI}?p=${MAX_BILIBILI_PART}`)).toMatchObject({
      part: MAX_BILIBILI_PART,
    });
  });

  it("keeps short links explicit and distinguishes absent part from an explicit first part", () => {
    expect(parseBilibiliResource("https://b23.tv/aB7_9-x/?share_source=fixture")).toEqual({
      kind: "short_link",
      platform: "bilibili",
      url: "https://b23.tv/aB7_9-x",
      needsResolution: true,
    });
    expect(parseBilibiliResource("https://b23.tv/aB7_9-x?p=1&share_source=fixture")).toEqual({
      kind: "short_link",
      platform: "bilibili",
      url: "https://b23.tv/aB7_9-x?p=1",
      part: 1,
      needsResolution: true,
    });
    expect(parseBilibiliResource(`https://b23.tv/${BV}?p=2`)).toEqual({
      kind: "short_link",
      platform: "bilibili",
      url: `https://b23.tv/${BV}?p=2`,
      part: 2,
      needsResolution: true,
    });
  });

  it.each([
    "BV1B7411m7L",
    "BV1B7411m7LVx",
    "bv1B7411m7LV",
    "BV1B7411m7L_",
    "BV1B7411m7Lé",
    "av0",
    "av-1",
    "av1.5",
    "av9007199254740992",
    "170001",
    "https://space.bilibili.com/170001",
    "https://www.bilibili.com/bangumi/play/ep170001",
    "https://www.bilibili.com/?bvid=BV1B7411m7LV",
    "https://www.bilibili.com/video/?bvid=BV1B7411m7LV",
    "https://www.bilibili.com/video/BV1B7411m7LV/extra",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=0",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=-1",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=1.5",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=1e2",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=1001",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=9007199254740992",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=2&p=2",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=2&%70=3",
    "https://www.bilibili.com/video/BV1B7411m7LV?p=2#p=3",
    "https://www.bilibili.com/video/BV1B7411m7LV#/video/av2",
    "https://b23.tv/",
    "https://b23.tv/a/b",
    "https://b23.tv/a?id=170001",
    "https://b23.tv/a?p=2&p=3",
    "https://b23.tv/a?p=0",
    "https://b23.tv/a?p=1001",
    "https://b23.tv/a#p=2",
    "https://b23.tv/%2Fa",
  ])("rejects unsupported identities and ambiguous parts %s", (input) =>
    invalid(parseBilibiliResource, input),
  );

  it("ignores query-contained video or host strings instead of selecting a different resource", () => {
    invalid(parseBilibiliResource, `https://evil.example/?url=${BILIBILI}`);
    expect(
      parseBilibiliResource(
        `${BILIBILI}?next=https%3A%2F%2Fevil.example%2Fvideo%2Fav999&bvid=BV1z8411D7yS`,
      ),
    ).toMatchObject({ id: BV, canonicalUrl: BILIBILI });
  });
});

describe("whole-link security boundary", () => {
  it.each([
    "http://HOST/RESOURCE",
    "ftp://HOST/RESOURCE",
    "javascript:https://HOST/RESOURCE",
    "//HOST/RESOURCE",
    "https:/HOST/RESOURCE",
    "https:HOST/RESOURCE",
    "https://HOST:80/RESOURCE",
    "https://HOST:8443/RESOURCE",
    "https://HOST:0443/RESOURCE",
    "https://owner:secret@HOST/RESOURCE",
    "https://@HOST/RESOURCE",
    "https://HOST.evil.example/RESOURCE",
    "https://HOST./RESOURCE",
    "https://HOST@evil.example/RESOURCE",
    "https://ｅvil.example/RESOURCE",
    "https://HOST\\evil.example/RESOURCE",
    "https://HOST/../RESOURCE",
    "https://HOST/%2e%2e/RESOURCE",
    "https://HOST/x/../RESOURCE",
    "https://HOST/RESOURCE\n",
    "https://HOST/RESOURCE\t",
    "https://HOST/RESOURCE\u0000",
    "https://HOST/RESOURCE https://HOST/RESOURCE",
    "分享: https://HOST/RESOURCE",
    "https://HOST/RESOURCE 后面的文字",
  ])("enforces HTTPS, literal authority, exact paths and whole input: %s", (template) => {
    invalid(
      parseNeteaseResource,
      template.replaceAll("HOST", "music.163.com").replaceAll("RESOURCE", "song?id=1"),
    );
    invalid(
      parseBilibiliResource,
      template.replaceAll("HOST", "www.bilibili.com").replaceAll("RESOURCE", `video/${BV}`),
    );
  });

  it("rejects authority encodings, cross-platform hosts and oversized inputs with safe errors", () => {
    invalid(parseNeteaseResource, "https://%6dusic.163.com/song?id=1");
    invalid(parseBilibiliResource, `https://%77ww.bilibili.com/video/${BV}`);
    invalid(parseNeteaseResource, BILIBILI);
    invalid(parseBilibiliResource, NETEASE);
    invalid(parseNeteaseResource, `${NETEASE}&private=${"x".repeat(MAX_MEDIA_LINK_LENGTH)}`);
    invalid(parseBilibiliResource, `${BILIBILI}?private=${"x".repeat(MAX_MEDIA_LINK_LENGTH)}`);
    for (const parser of [parseNeteaseResource, parseBilibiliResource]) {
      invalid(parser, "private input with token=test-token");
      expect(() => parser(null as unknown as string)).toThrow(MediaLinkParseError);
    }
  });

  it("never invokes fetch or resolves short-link redirects", () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network must not run"));
    try {
      parseNeteaseResource("https://163cn.tv/fixture");
      parseBilibiliResource("https://b23.tv/fixture?p=2");
      parseNeteaseResource(NETEASE);
      parseBilibiliResource(BILIBILI);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
