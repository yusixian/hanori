import { client } from "@/lib/client";
import type { InferResponseType } from "hono/client";

export type ConversationsResponse = InferResponseType<
  (typeof client.api.bots)[":botId"]["conversations"]["$get"],
  200
>;
export type ConversationItem = ConversationsResponse["data"][number];
export type ConversationMessage = InferResponseType<
  (typeof client.api.bots)[":botId"]["conversations"][":chatId"]["$get"],
  200
>["data"][number];
export type ConversationSummary = InferResponseType<
  (typeof client.api.bots)[":botId"]["conversations"][":chatId"]["summaries"]["$get"],
  200
>["data"][number];
export type SummaryCleanupPreview = InferResponseType<
  (typeof client.api.bots)[":botId"]["conversations"][":chatId"]["summaries"]["cleanup-preview"]["$get"],
  200
>;
