import { describe, expect, it, vi } from "vitest";
import { MiniAppAccessPolicy, type TelegramMembershipVerifier } from "./mini-app-access-policy.js";

const BOT_ID = "bot-a";
const USER_ID = 42;

function verifier(implementation: TelegramMembershipVerifier["isMember"]) {
  return { isMember: vi.fn(implementation) };
}

function input(membershipVerifier: TelegramMembershipVerifier) {
  return {
    botId: BOT_ID,
    telegramUserId: USER_ID,
    adminTelegramUserIds: [] as number[],
    operatorTelegramUserIds: [] as number[],
    grantedChatIds: [-1001, -1002],
    membershipVerifier,
  };
}

describe("MiniAppAccessPolicy", () => {
  it("uses admin > operator > viewer > none priority", async () => {
    const membership = verifier(async () => true);
    const policy = new MiniAppAccessPolicy();

    const admin = await policy.resolve({
      ...input(membership),
      adminTelegramUserIds: [USER_ID],
      operatorTelegramUserIds: [USER_ID],
    });
    expect(admin.role).toBe("admin");
    expect(admin.chatScope).toEqual({ kind: "all" });
    expect(membership.isMember).not.toHaveBeenCalled();

    const operator = await policy.resolve({
      ...input(membership),
      operatorTelegramUserIds: [USER_ID],
    });
    expect(operator.role).toBe("operator");
    expect(operator.chatScope).toEqual({ kind: "granted", chatIds: [-1001, -1002] });

    const viewer = await policy.resolve(input(membership));
    expect(viewer.role).toBe("viewer");

    const none = await policy.resolve({
      ...input(verifier(async () => false)),
      grantedChatIds: [],
    });
    expect(none.role).toBe("none");
  });

  it("keeps operator and chat grants independent and reads fresh grants each time", async () => {
    const membership = verifier(async () => false);
    const policy = new MiniAppAccessPolicy();
    const base = input(membership);

    expect(
      (await policy.resolve({ ...base, operatorTelegramUserIds: [USER_ID], grantedChatIds: [] }))
        .role,
    ).toBe("operator");
    expect(
      (await policy.resolve({ ...base, operatorTelegramUserIds: [], grantedChatIds: [-1001] }))
        .role,
    ).toBe("none");
  });

  it("checks each granted chat and fails closed per membership error", async () => {
    const membership = verifier(async ({ chatId }) => {
      if (chatId === -1001) throw new Error("Telegram unavailable");
      return chatId === -1002;
    });
    const result = await new MiniAppAccessPolicy().resolve(input(membership));

    expect(result.role).toBe("viewer");
    expect(result.chatScope).toEqual({ kind: "granted", chatIds: [-1002] });
    expect(membership.isMember).toHaveBeenCalledTimes(2);
    expect(membership.isMember).toHaveBeenNthCalledWith(1, {
      botId: BOT_ID,
      chatId: -1001,
      userId: USER_ID,
    });

    const unavailable = verifier(async () => {
      throw new Error("Telegram unavailable");
    });
    const denied = await new MiniAppAccessPolicy().resolve(input(unavailable));
    expect(denied).toMatchObject({ role: "none", chatScope: { kind: "none" } });
  });

  it("rejects invalid user and chat identifiers without calling Telegram", async () => {
    const membership = verifier(async () => true);
    const policy = new MiniAppAccessPolicy();
    const invalidUser = await policy.resolve({
      ...input(membership),
      telegramUserId: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(invalidUser.role).toBe("none");

    const invalidChats = await policy.resolve({
      ...input(membership),
      grantedChatIds: [0, 10, Number.MIN_SAFE_INTEGER - 1],
    });
    expect(invalidChats.role).toBe("none");
    expect(membership.isMember).not.toHaveBeenCalled();
  });
});
