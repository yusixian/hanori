import type { GitHubIssueProposal, GitHubIssueProposalPort } from "@cos-tool-bot/shared";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubIssueProposalCallbackHandler,
  formatGitHubIssueProposal,
  githubIssueProposalKeyboard,
  sendGitHubIssueProposal,
} from "./github-issue-confirmation.js";

const proposal: GitHubIssueProposal = {
  id: "a".repeat(24),
  botId: "00000000-0000-4000-8000-000000000001",
  chatId: -100,
  threadId: 12,
  initiator: 7,
  repository: "owner/repo",
  title: "Title",
  body: "Body",
  hash: "b".repeat(64),
  createdAt: 1,
  expiresAt: null,
  status: "pending",
};
function setup() {
  const api = {
    raw: { answerCallbackQuery: vi.fn().mockResolvedValue(true) },
    editMessageText: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue(true),
  };
  const port = {
    propose: vi.fn(),
    list: vi.fn(),
    decide: vi.fn().mockResolvedValue({ ...proposal, status: "completed" }),
  };
  const query = {
    id: "query",
    data: `cos:ghi:${proposal.id}:yes`,
    from: { id: 7 },
    message: { chat: { id: -100 }, message_id: 1, message_thread_id: 12 },
  };
  return {
    api,
    port,
    query,
    handler: createGitHubIssueProposalCallbackHandler(
      api as unknown as Api,
      port as GitHubIssueProposalPort,
    ),
  };
}

describe("durable Issue Telegram cards", () => {
  it("shows no expiry or exact expiry with content hash and uses original topic", async () => {
    expect(formatGitHubIssueProposal(proposal)).toContain("不过期");
    expect(formatGitHubIssueProposal(proposal)).toContain(proposal.hash);
    const expiresAt = Date.parse("2026-10-10T00:00:00Z");
    expect(formatGitHubIssueProposal({ ...proposal, expiresAt })).toContain(
      "2026-10-10T00:00:00.000Z",
    );
    const { api } = setup();
    await sendGitHubIssueProposal(api as unknown as Api, proposal);
    expect(api.sendMessage).toHaveBeenCalledWith(
      -100,
      expect.any(String),
      expect.objectContaining({ message_thread_id: 12 }),
    );
    for (const status of [
      "cancelled",
      "completed",
      "expired",
      "superseded",
      "executing",
      "not_executed",
    ] as const) {
      expect(
        githubIssueProposalKeyboard({ ...proposal, status }).inline_keyboard.flat(),
      ).toHaveLength(0);
    }
    expect(
      githubIssueProposalKeyboard({ ...proposal, status: "result_unknown" }).inline_keyboard.flat(),
    ).toEqual([{ text: "核实已有 Issue", callback_data: `cos:ghi:${proposal.id}:verify` }]);
  });

  it.each([
    ["yes", "confirm"],
    ["no", "cancel"],
    ["verify", "verify"],
  ])(
    "routes %s to the tenant-bound service with the current click identity",
    async (button, decision) => {
      const { handler, port, query } = setup();
      await expect(
        handler({ callbackQuery: { ...query, data: `cos:ghi:${proposal.id}:${button}` } }),
      ).resolves.toBe(true);
      expect(port.decide).toHaveBeenCalledWith(
        proposal.id,
        { chatId: -100, threadId: 12, userId: 7 },
        decision,
      );
    },
  );

  it("keeps the original card if current authorization rejects a click", async () => {
    const { handler, port, api, query } = setup();
    port.decide.mockRejectedValueOnce(new Error("permission revoked"));
    await handler({ callbackQuery: query });
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(-100, "permission revoked", {
      message_thread_id: 12,
    });
  });

  it("does not let a failed Telegram acknowledgement bypass or lose service validation", async () => {
    const { handler, port, api, query } = setup();
    api.raw.answerCallbackQuery.mockRejectedValueOnce(new Error("Telegram timeout"));
    await handler({ callbackQuery: query });
    expect(port.decide).toHaveBeenCalledOnce();
  });

  it("rejects malformed/inaccessible messages and leaves old high-risk namespaces alone", async () => {
    const { handler, port, query } = setup();
    expect(await handler({ callbackQuery: { ...query, data: "cos:gh:old:yes" } })).toBe(false);
    expect(await handler({ callbackQuery: { ...query, data: "cos:ghi:bad:yes" } })).toBe(true);
    expect(await handler({ callbackQuery: { ...query, message: undefined } })).toBe(true);
    expect(port.decide).not.toHaveBeenCalled();
  });
});

it("shows a safe integer expiry beyond Date range and a definitely unexecuted terminal card", () => {
  expect(formatGitHubIssueProposal({ ...proposal, expiresAt: Number.MAX_SAFE_INTEGER })).toContain(
    `Unix 毫秒 ${Number.MAX_SAFE_INTEGER}`,
  );
  const text = formatGitHubIssueProposal({ ...proposal, status: "not_executed" });
  expect(text).toContain("尚未发送创建请求");
  expect(text).not.toContain("结果未知");
});
