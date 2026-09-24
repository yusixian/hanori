import { createHash } from "node:crypto";
import type { HarnessKeyboard } from "@cos-tool-bot/bot";
import type { HarnessService } from "./service.js";
import type { HarnessRequestPatch, HarnessRequestRecord } from "./store.js";

export interface CardContent {
  html: string;
  keyboard: HarnessKeyboard;
  imageUrl: string | null;
}

export function contentHash(card: CardContent): string {
  return createHash("sha256")
    .update(JSON.stringify([card.html, card.keyboard, card.imageUrl]))
    .digest("hex")
    .slice(0, 32);
}

/**
 * One card per request: edits the existing message in place and sends a new one only when there
 * is none to edit. Returns the request fields that describe the card now on screen.
 */
export async function publishCard(
  service: HarnessService,
  projectKey: string,
  request: HarnessRequestRecord,
  card: CardContent,
  options: { replyToMessageId?: number } = {},
): Promise<HarnessRequestPatch> {
  const telegram = service.telegram;
  if (!telegram) return {};
  const chatId = service.file.telegram.chatId;
  const editable = request.cardMessageId !== null && request.chatId === chatId;
  const hash = contentHash(card);
  if (editable) {
    if (request.cardHash === hash) return {};
    const isPhoto = request.cardKind === "photo";
    const photoChanged = isPhoto && card.imageUrl && card.imageUrl !== request.cardImageUrl;
    const result = await telegram.edit(chatId, request.cardMessageId!, isPhoto ? "photo" : "text", {
      html: card.html,
      keyboard: card.keyboard,
      photoUrl: photoChanged ? card.imageUrl! : undefined,
    });
    if (result !== "missing") {
      return { cardHash: hash, ...(photoChanged ? { cardImageUrl: card.imageUrl } : {}) };
    }
  }
  const threadId = service.projectThread(projectKey);
  const sent = await telegram.send(chatId, {
    html: card.html,
    keyboard: card.keyboard,
    threadId,
    photoUrl: card.imageUrl ?? undefined,
    replyToMessageId: options.replyToMessageId,
  });
  await service.recordEvent({
    type: "card.sent",
    projectKey,
    requestId: request.id,
    payload: { messageId: sent.messageId, kind: sent.kind },
  });
  return {
    chatId,
    threadId: threadId ?? null,
    cardMessageId: sent.messageId,
    cardKind: sent.kind,
    cardImageUrl: sent.kind === "photo" ? card.imageUrl : null,
    cardHash: hash,
  };
}
