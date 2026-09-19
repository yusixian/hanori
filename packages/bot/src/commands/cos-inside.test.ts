import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { WrapperContext } from "../context.js";
import { createAuthGuard, privateChatOnlyGuard } from "../guards/auth.js";
import {
  COS_INSIDE_MAX_BODY_LENGTH,
  createCosInsideCommand,
  type CosInsideAuditEntry,
} from "./cos-inside.js";

type CommandRunner = (ctx: WrapperContext, next: () => Promise<void>) => Promise<void>;

const ADMIN_ID = 42;
const TARGETS = [
  { alias: "ops", chatId: -1001 },
  { alias: "dev", chatId: -1002 },
];

function createContext(
  text: string,
  options: { userId?: number; chatType?: string; asCaption?: boolean } = {},
) {
  const replies: string[] = [];
  const sendMessage = vi.fn(async () => ({ message_id: 1 }));
  const ctx = {
    from: { id: options.userId ?? ADMIN_ID },
    chat: { id: options.userId ?? ADMIN_ID, type: options.chatType ?? "private" },
    match: text,
    message: options.asCaption ? { caption: `/cosinside ${text}` } : { text: `/cosinside ${text}` },
    api: { sendMessage },
    reply: async (message: string) => {
      replies.push(message);
    },
  } as unknown as WrapperContext;
  return { ctx, replies, sendMessage };
}

function createRelay(
  config: { targets?: Array<{ alias: string; chatId: number }>; now?: () => number } = {},
): {
  run: (ctx: WrapperContext) => Promise<void>;
  audits: CosInsideAuditEntry[];
} {
  const audits: CosInsideAuditEntry[] = [];
  const command = createCosInsideCommand({
    targets: config.targets ?? TARGETS,
    onAudit: (entry) => {
      audits.push(entry);
    },
    ...(config.now ? { now: config.now } : {}),
  }) as unknown as CommandRunner;
  return { run: (ctx: WrapperContext) => command(ctx, async () => {}), audits };
}

describe("cosinside access", () => {
  it("denies a non-admin without naming the command or any target", async () => {
    const guard = createAuthGuard([ADMIN_ID]) as unknown as CommandRunner;
    const { ctx, replies } = createContext("ops hello", { userId: 999 });
    const next = vi.fn(async () => {});

    await guard(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(replies).toEqual(["[权限不足] 这种事人家确实帮不上忙呢，可以找管理员试试哟～"]);
    expect(replies.join(" ")).not.toContain("cosinside");
    expect(replies.join(" ")).not.toContain("ops");
  });

  it("denies the command outside a private chat with the same text", async () => {
    const { ctx, replies } = createContext("ops hello", { chatType: "supergroup" });
    const next = vi.fn(async () => {});

    await (privateChatOnlyGuard as unknown as CommandRunner)(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(replies).toEqual(["[权限不足] 这种事人家确实帮不上忙呢，可以找管理员试试哟～"]);
  });
});

describe("createCosInsideCommand", () => {
  it("answers a bare command with a short usage line", async () => {
    const { run } = createRelay();
    const { ctx, replies, sendMessage } = createContext("");

    await run(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(replies).toEqual(["用法：/cosinside <别名> [reply:<消息ID>] <正文>"]);
  });

  it("relays to the chat id that the alias resolves to", async () => {
    const { run, audits } = createRelay();
    const { ctx, replies, sendMessage } = createContext("dev 今晚发版");

    await run(ctx);

    expect(sendMessage).toHaveBeenCalledWith(-1002, "今晚发版", undefined);
    expect(replies).toEqual(["已代发至 dev。"]);
    expect(audits).toEqual([
      {
        actorUserId: ADMIN_ID,
        targetChatId: -1002,
        alias: "dev",
        bodyLength: 4,
        hasReplyTarget: false,
        outcome: "succeeded",
      },
    ]);
  });

  it("accepts an omitted alias only when a single target is configured", async () => {
    const { run, audits } = createRelay({ targets: [TARGETS[0]!] });
    const { ctx, sendMessage } = createContext("今晚发版");

    await run(ctx);

    expect(sendMessage).toHaveBeenCalledWith(-1001, "今晚发版", undefined);
    expect(audits[0]?.alias).toBe("ops");
  });

  it("asks for an alias when several targets are configured", async () => {
    const { run, audits } = createRelay();
    const { ctx, replies, sendMessage } = createContext("今晚发版");

    await run(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    expect(replies).toEqual(["未知目标别名。已配置：ops、dev"]);
  });

  it("reports an unknown alias without any chat id", async () => {
    const { run } = createRelay();
    const { ctx, replies, sendMessage } = createContext("marketing 今晚发版");

    await run(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(replies).toEqual(["未知目标别名。已配置：ops、dev"]);
    expect(replies.join(" ")).not.toContain("1001");
    expect(replies.join(" ")).not.toContain("1002");
  });

  it("turns reply:<id> into reply_parameters", async () => {
    const { run, audits } = createRelay();
    const { ctx, sendMessage } = createContext("ops reply:77 收到");

    await run(ctx);

    expect(sendMessage).toHaveBeenCalledWith(-1001, "收到", {
      reply_parameters: { message_id: 77 },
    });
    expect(audits[0]?.hasReplyTarget).toBe(true);
  });

  it("reports a rejected reply target instead of sending a plain message", async () => {
    const { run, audits } = createRelay();
    const { ctx, replies, sendMessage } = createContext("ops reply:77 收到");
    sendMessage.mockRejectedValueOnce(
      new GrammyError(
        "Call to 'sendMessage' failed!",
        { ok: false, error_code: 400, description: "Bad Request: message to reply not found" },
        "sendMessage",
        {},
      ),
    );

    await run(ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(replies).toEqual(["代发失败：Bad Request: message to reply not found"]);
    expect(audits[0]).toMatchObject({
      outcome: "failed",
      failureReason: "Bad Request: message to reply not found",
    });
  });

  it("rejects a body over the length limit", async () => {
    const { run, audits } = createRelay();
    const body = "字".repeat(COS_INSIDE_MAX_BODY_LENGTH + 1);
    const { ctx, replies, sendMessage } = createContext(`ops ${body}`);

    await run(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    expect(replies).toEqual([
      `正文超过 4000 字符上限，当前 ${COS_INSIDE_MAX_BODY_LENGTH + 1} 字符。`,
    ]);
  });

  it("limits one admin to five relays per minute and recovers after the window", async () => {
    let now = 1_000;
    const { run } = createRelay({ now: () => now });
    const send = async () => {
      const { ctx, replies, sendMessage } = createContext("ops 内容");
      await run(ctx);
      return { replies, sendMessage };
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await send();
      expect(result.sendMessage).toHaveBeenCalledTimes(1);
    }

    const limited = await send();
    expect(limited.sendMessage).not.toHaveBeenCalled();
    expect(limited.replies).toEqual(["代发过于频繁，每 60 秒最多 5 条。"]);

    now += 60_000;
    const recovered = await send();
    expect(recovered.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the relayed text out of every audit field", async () => {
    const { run, audits } = createRelay();
    const secret = "内部通知：明早九点开会";
    const { ctx } = createContext(`ops ${secret}`);

    await run(ctx);

    expect(audits).toHaveLength(1);
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain(secret);
    for (const fragment of secret) {
      expect(serialized).not.toContain(fragment);
    }
    expect(Object.keys(audits[0]!).sort()).toEqual([
      "actorUserId",
      "alias",
      "bodyLength",
      "hasReplyTarget",
      "outcome",
      "targetChatId",
    ]);
  });

  it("refuses a command written in a media caption instead of relaying the caption alone", async () => {
    const { run, audits } = createRelay();
    const { ctx, replies, sendMessage } = createContext("ops 看图", { asCaption: true });

    await run(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    expect(replies).toEqual(["只支持纯文本代发，请不要把命令写在图片或文件的说明里。"]);
  });

  it("reports that no target is configured", async () => {
    const { run } = createRelay({ targets: [] });
    const { ctx, replies, sendMessage } = createContext("ops 内容");

    await run(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(replies).toEqual(["尚未配置代发目标群。"]);
  });
});
