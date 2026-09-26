import { describe, expect, it, vi } from "vitest";
import { harnessRoutes } from "../routes/harness.js";
import {
  attachmentKey,
  attachmentToken,
  detectImageMime,
  verifyAttachmentToken,
} from "./attachments.js";
import { bugIssueBody } from "./bug.js";
import { TEST_CHAT_ID, TEST_OWNER } from "./test-fakes.js";
import { setup } from "./work-test-helpers.js";

const KEY = attachmentKey("x".repeat(32));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

describe("attachment tokens", () => {
  it("round-trips a file id and rejects forged or altered tokens", () => {
    const token = attachmentToken(KEY, "AgACfile");
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(verifyAttachmentToken(KEY, token)).toBe("AgACfile");
    expect(verifyAttachmentToken(attachmentKey("y".repeat(32)), token)).toBeNull();
    const [, mac] = token.split(".");
    const other = Buffer.from("AgACother").toString("base64url");
    expect(verifyAttachmentToken(KEY, `${other}.${mac}`)).toBeNull();
    expect(verifyAttachmentToken(KEY, `${token}.x`)).toBeNull();
    expect(verifyAttachmentToken(KEY, "not-a-token")).toBeNull();
  });

  it("recognizes only image bytes", () => {
    expect(detectImageMime(JPEG)).toBe("image/jpeg");
    expect(detectImageMime(Buffer.from("<html>"))).toBeNull();
  });
});

describe("bugIssueBody", () => {
  it("embeds linked images and lists the rest by kind, never a Telegram URL", () => {
    const body = bugIssueBody({
      text: "头像裂了",
      requestId: "r1",
      attachments: [
        { kind: "photo", fileId: "p1", width: 1280, height: 720 },
        { kind: "document", fileId: "d1", mimeType: "application/pdf" },
      ],
      linkFor: (fileId) => `https://bot.example.test/api/harness/attachments/${fileId}.sig`,
    });
    expect(body).toContain(
      "![screenshot 1 (1280×720)](https://bot.example.test/api/harness/attachments/p1.sig)",
    );
    expect(body).toContain("- document: `d1`");
    expect(body).not.toContain("api.telegram.org");
  });
});

describe("/bug screenshots", () => {
  async function screenshotSetup() {
    const ctx = await setup({
      panelUrl: "https://bot.example.test/",
      attachmentSecret: "x".repeat(32),
    });
    ctx.telegram.files.set("AgACphoto", JPEG);
    ctx.telegram.files.set("BQACdoc", Buffer.from("%PDF-1.7"));
    await ctx.port.handleCommand({
      command: "bug",
      args: "头像裂了",
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: 9,
      attachments: [{ kind: "photo", fileId: "AgACphoto", width: 900, height: 600 }],
    });
    const body = ctx.github.issues[0]!.body;
    const url = /\((https:\/\/bot\.example\.test\/api\/harness\/attachments\/[^)]+)\)/.exec(
      body,
    )?.[1];
    return { ctx, body, url: url! };
  }

  it("links the photo through a signed URL and serves it from Telegram once", async () => {
    const { ctx, body, url } = await screenshotSetup();
    expect(body).toContain("![screenshot 1 (900×600)](");
    expect(ctx.telegram.downloads).toEqual([]);
    const token = url.split("/").at(-1)!;
    expect(await ctx.service.attachments.read(token)).toEqual({
      bytes: JPEG,
      mimeType: "image/jpeg",
    });
    await ctx.service.attachments.read(token);
    expect(ctx.telegram.downloads).toEqual(["AgACphoto"]);

    const pdf = attachmentToken(attachmentKey("x".repeat(32)), "BQACdoc");
    expect(await ctx.service.attachments.read(pdf)).toBeNull();
    expect(await ctx.service.attachments.read(`${token.slice(0, -2)}AA`)).toBeNull();
  });

  it("keeps file ids only without a public URL or secret", async () => {
    const ctx = await setup({ panelUrl: "https://bot.example.test/" });
    await ctx.port.handleCommand({
      command: "bug",
      args: "头像裂了",
      chatId: TEST_CHAT_ID,
      threadId: 501,
      userId: TEST_OWNER,
      messageId: 9,
      attachments: [{ kind: "photo", fileId: "AgACphoto" }],
    });
    expect(ctx.github.issues[0]!.body).toContain("- photo: `AgACphoto`");
  });
});

describe("GET /api/harness/attachments/:token", () => {
  it("returns the image, and 404 for unknown tokens or failures", async () => {
    const read = vi.fn(async (token: string) => {
      if (token === "boom") throw new Error("telegram down");
      return token === "ok" ? { bytes: JPEG, mimeType: "image/jpeg" } : null;
    });
    const app = harnessRoutes({
      handleGitHubWebhook: vi.fn(),
      handleLodyTurn: vi.fn(),
      attachments: { read },
    });
    const ok = await app.request("/attachments/ok");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(JPEG);
    expect((await app.request("/attachments/nope")).status).toBe(404);
    expect((await app.request("/attachments/boom")).status).toBe(404);
    expect((await harnessRoutes(undefined).request("/attachments/ok")).status).toBe(404);
  });
});
