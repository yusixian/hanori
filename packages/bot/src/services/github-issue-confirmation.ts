import type { GitHubIssueProposal, GitHubIssueProposalPort } from "@cos-tool-bot/shared";
import { InlineKeyboard, type Api } from "grammy";

export function formatGitHubIssueProposal(proposal: GitHubIssueProposal) {
  const expiryDate = proposal.expiresAt === null ? null : new Date(proposal.expiresAt);
  const validity =
    expiryDate === null
      ? "不过期"
      : Number.isFinite(expiryDate.getTime())
        ? `有效至 ${expiryDate.toISOString()}`
        : `有效至 Unix 毫秒 ${proposal.expiresAt}`;
  const status = {
    pending: "待发起管理员确认",
    executing: "正在执行，请勿重发",
    completed: proposal.result?.summary ?? "已完成",
    cancelled: "已取消",
    not_executed: "未执行：确认前复查未通过或执行中断，尚未发送创建请求；旧卡不可执行。",
    expired: "已过期",
    superseded: "已替代，旧卡不可执行",
    result_unknown: "结果未知；仅可核实，不会重新创建。核实未找到也不代表创建失败。",
  }[proposal.status];
  return [
    "🔐 GitHub Issue 管理员确认",
    `提案：${proposal.id}`,
    `在 ${proposal.repository} 创建 Issue`,
    `标题：${proposal.title}`,
    `正文预览：${proposal.body.slice(0, 600) || "（空）"}${proposal.body.length > 600 ? "…" : ""}`,
    `完整提案 SHA-256：${proposal.hash}`,
    "正文会附带不可变提案核实标记。",
    validity,
    status,
    proposal.result?.url ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function githubIssueProposalKeyboard(proposal: GitHubIssueProposal) {
  const keyboard = new InlineKeyboard();
  if (proposal.status === "pending") {
    keyboard
      .text("确认创建 Issue", `cos:ghi:${proposal.id}:yes`)
      .text("撤销提案", `cos:ghi:${proposal.id}:no`);
  } else if (proposal.status === "result_unknown") {
    keyboard.text("核实已有 Issue", `cos:ghi:${proposal.id}:verify`);
  }
  return keyboard;
}

export async function sendGitHubIssueProposal(api: Api, proposal: GitHubIssueProposal) {
  await api.sendMessage(proposal.chatId, formatGitHubIssueProposal(proposal), {
    reply_markup: githubIssueProposalKeyboard(proposal),
    ...(proposal.threadId === null ? {} : { message_thread_id: proposal.threadId }),
  });
}

export function createGitHubIssueProposalCallbackHandler(api: Api, port: GitHubIssueProposalPort) {
  return async (ctx: {
    callbackQuery: {
      id: string;
      data?: string;
      from: { id: number };
      message?: { chat: { id: number }; message_id: number; message_thread_id?: number };
    };
  }) => {
    const { callbackQuery: query } = ctx;
    if (!query.data?.startsWith("cos:ghi:")) return false;
    const match = /^cos:ghi:([\da-f]{24}):(yes|no|verify)$/.exec(query.data);
    if (!match || !query.message) {
      await api.raw.answerCallbackQuery({
        callback_query_id: query.id,
        text: "无效的 GitHub 提案按钮",
        show_alert: true,
      });
      return true;
    }
    // A Telegram acknowledgement is presentation only; it never claims or approves a proposal.
    await api.raw
      .answerCallbackQuery({ callback_query_id: query.id, text: "正在校验当前授权" })
      .catch(() => {});
    try {
      const proposal = await port.decide(
        match[1]!,
        {
          userId: query.from.id,
          chatId: query.message.chat.id,
          threadId: query.message.message_thread_id,
        },
        match[2] === "yes" ? "confirm" : match[2] === "no" ? "cancel" : "verify",
      );
      await api
        .editMessageText(
          proposal.chatId,
          query.message.message_id,
          formatGitHubIssueProposal(proposal),
          {
            reply_markup: githubIssueProposalKeyboard(proposal),
          },
        )
        .catch(() => {});
    } catch (error) {
      // Keep the original card intact: unauthorized users cannot remove another user's buttons.
      await api
        .sendMessage(
          query.message.chat.id,
          error instanceof Error ? error.message : "GitHub 提案校验失败",
          query.message.message_thread_id === undefined
            ? {}
            : { message_thread_id: query.message.message_thread_id },
        )
        .catch(() => {});
    }
    return true;
  };
}
