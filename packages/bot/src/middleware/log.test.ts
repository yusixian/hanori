import { describe, expect, test, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createLogMiddleware } from "./log.js";

describe("createLogMiddleware", () => {
  test("omits text content from group message logs", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 7, username: "member" },
      chat: { id: -100123, type: "supergroup" },
      message: { message_id: 42, text: "private group conversation" },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Message from member",
      meta: {
        userId: 7,
        username: "member",
        chatId: -100123,
        chatType: "supergroup",
        messageId: 42,
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("private group conversation");
    expect(next).toHaveBeenCalledOnce();
  });

  test("keeps the command name but omits group command arguments", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 7, username: "member" },
      chat: { id: -123, type: "group" },
      message: {
        text: "/model secret-model-name",
        entities: [{ type: "bot_command" }],
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Command /model from member",
      meta: {
        userId: 7,
        username: "member",
        chatId: -123,
        chatType: "group",
        command: "model",
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("secret-model-name");
    expect(next).toHaveBeenCalledOnce();
  });

  test("keeps the media kind but omits group captions", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 7, username: "member" },
      chat: { id: -100123, type: "supergroup" },
      message: {
        caption: "sensitive photo caption",
        photo: [{ file_id: "photo-id", file_unique_id: "unique-id", width: 10, height: 10 }],
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Photo from member",
      meta: {
        userId: 7,
        username: "member",
        chatId: -100123,
        chatType: "supergroup",
        mediaKind: "photo",
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("sensitive photo caption");
    expect(next).toHaveBeenCalledOnce();
  });

  test("keeps the media kind but omits group file names", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 7, username: "member" },
      chat: { id: -123, type: "group" },
      message: {
        document: {
          file_id: "document-id",
          file_unique_id: "unique-id",
          file_name: "confidential-plan.pdf",
        },
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Document from member",
      meta: {
        userId: 7,
        username: "member",
        chatId: -123,
        chatType: "group",
        mediaKind: "document",
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("confidential-plan.pdf");
    expect(next).toHaveBeenCalledOnce();
  });

  test("keeps safe video structure but omits group video content", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 7, username: "member" },
      chat: { id: -100123, type: "supergroup" },
      message: {
        caption: "sensitive video caption",
        video: {
          file_id: "video-id",
          file_unique_id: "unique-id",
          file_name: "private-video.mp4",
          width: 10,
          height: 10,
          duration: 12,
        },
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Video from member",
      meta: {
        userId: 7,
        username: "member",
        chatId: -100123,
        chatType: "supergroup",
        mediaKind: "video",
        durationSeconds: 12,
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("sensitive video caption");
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("private-video.mp4");
    expect(next).toHaveBeenCalledOnce();
  });

  test("keeps update identifiers but omits group animation file names", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      update: { update_id: 99 },
      from: { id: 7, username: "member" },
      chat: { id: -100123, type: "supergroup" },
      message: {
        message_id: 43,
        animation: {
          file_id: "animation-id",
          file_unique_id: "unique-id",
          file_name: "private-animation.gif",
          width: 10,
          height: 10,
          duration: 4,
        },
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "GIF from member",
      meta: {
        userId: 7,
        username: "member",
        chatId: -100123,
        chatType: "supergroup",
        updateId: 99,
        messageId: 43,
        mediaKind: "animation",
        durationSeconds: 4,
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("private-animation.gif");
    expect(next).toHaveBeenCalledOnce();
  });

  test("omits group sticker pack content", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 7, username: "member" },
      chat: { id: -123, type: "group" },
      message: {
        sticker: {
          file_id: "sticker-id",
          file_unique_id: "unique-id",
          type: "regular",
          width: 10,
          height: 10,
          is_animated: false,
          is_video: false,
          emoji: "🔐",
          set_name: "private_sticker_pack",
        },
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Sticker from member",
      meta: {
        userId: 7,
        username: "member",
        chatId: -123,
        chatType: "group",
        mediaKind: "sticker",
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("private_sticker_pack");
    expect(next).toHaveBeenCalledOnce();
  });

  test("redacts /apikey command arguments", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 1, username: "admin" },
      chat: { id: 1, type: "private" },
      message: {
        text: "/apikey image secret-value",
        entities: [{ type: "bot_command" }],
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Command /apikey from admin",
      meta: {
        userId: 1,
        username: "admin",
        chatId: 1,
        chatType: "private",
        command: "apikey",
        args: "[REDACTED]",
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("secret-value");
    expect(next).toHaveBeenCalledOnce();
  });

  test("redacts the relayed body of /cosinside", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 1, username: "admin" },
      chat: { id: 1, type: "private" },
      message: {
        text: "/cosinside ops 内部通知：明早九点开会",
        entities: [{ type: "bot_command" }],
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog).toHaveBeenCalledWith({
      level: "info",
      message: "Command /cosinside from admin",
      meta: {
        userId: 1,
        username: "admin",
        chatId: 1,
        chatType: "private",
        command: "cosinside",
        args: "[REDACTED]",
      },
    });
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("内部通知");
    expect(next).toHaveBeenCalledOnce();
  });

  test("keeps arguments of a command that carries no secret", async () => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 1, username: "admin" },
      chat: { id: 1, type: "private" },
      message: {
        text: "/summary 6h",
        entities: [{ type: "bot_command" }],
      },
    };

    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);

    expect(onLog.mock.calls[0]?.[0]?.meta).toMatchObject({ command: "summary", args: "6h" });
  });
  test.each([
    ["photo", "/cosinside"],
    ["video", "/cosinside@test_bot"],
    ["photo", "/apikey"],
    ["video", "/apikey@test_bot"],
  ])("redacts sensitive %s caption command %s before handler rejection", async (kind, command) => {
    const onLog = vi.fn();
    const next = vi.fn();
    const ctx = {
      from: { id: 1, username: "admin" },
      chat: { id: 1, type: "private" },
      message: {
        [kind]: kind === "photo" ? [] : { duration: 1 },
        caption: `${command} ops confidential-body\nsecond-line`,
        caption_entities: [{ type: "bot_command", offset: 0, length: command.length }],
      },
    };
    await createLogMiddleware(onLog)(ctx as unknown as WrapperContext, next);
    expect(onLog).toHaveBeenCalledOnce();
    expect(onLog.mock.calls[0]?.[0]?.message).toBe(
      `${kind === "photo" ? "Photo" : "Video"}: [REDACTED] from admin`,
    );
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("confidential-body");
    expect(JSON.stringify(onLog.mock.calls)).not.toContain("second-line");
    expect(next).toHaveBeenCalledOnce();
  });
});
