import type {
  PluginContext,
  PluginTool,
  VideoDownloadActor,
  VideoDownloadPort,
} from "@cos-tool-bot/shared";
import { z } from "zod";
import { VideoDownloadError } from "../video-downloads/contracts.js";

const jobSchema = z.object({ id: z.uuid() }).strict();

export function createVideoDownloadTools(
  context: PluginContext,
  port: VideoDownloadPort,
): PluginTool[] {
  if (context.actor.userId === undefined) return [];
  const actor: VideoDownloadActor = {
    botId: context.actor.botId,
    chatId: context.actor.chatId,
    userId: context.actor.userId,
    isAdmin: context.actor.isAdmin,
    ...(context.actor.threadId === undefined ? {} : { threadId: context.actor.threadId }),
  };
  function entry<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    effect: PluginTool["effect"],
    execute: (input: z.output<T>, signal: AbortSignal) => Promise<unknown>,
  ): PluginTool {
    return {
      name,
      description,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      effect,
      access: "admin",
      execute: async (input, signal) => {
        const parsed = schema.safeParse(input);
        if (!parsed.success) return { error: "invalid_arguments" };
        const combined = AbortSignal.any([context.signal, signal]);
        try {
          combined.throwIfAborted();
          return await execute(parsed.data, combined);
        } catch (error) {
          return {
            error: combined.aborted
              ? "cancelled"
              : error instanceof VideoDownloadError
                ? error.code
                : "video_download_failed",
          };
        }
      },
    };
  }
  return [
    entry(
      "download_video",
      "Create a background download of one Bilibili video and send the MP4 to this Telegram chat/topic only when the administrator explicitly asks for download and delivery. The host binds identity and destination. Returns a job immediately after validation; no automatic ASR, playlists, live streams, DRM bypass or arbitrary output paths. Do not repeatedly create jobs to retry failures or unknown delivery outcomes.",
      z.object({ sourceUrl: z.string().trim().min(1).max(2048) }).strict(),
      "mutating",
      (input, signal) => port.create(actor, input, signal),
    ),
    entry(
      "get_video_download",
      "Get status and a safe failure reason for this administrator's video download in this Bot/chat/topic. A delivery_unknown outcome requires checking Telegram; do not automatically resend.",
      jobSchema,
      "read_only",
      ({ id }) => port.get(actor, id),
    ),
    entry(
      "cancel_video_download",
      "Request cancellation of this administrator's video download. Inspect the returned status: sending may already be irreversible; cancellation does not retract a Telegram message and must not be reported as successful when delivery has started.",
      jobSchema,
      "mutating",
      ({ id }) => port.cancel(actor, id),
    ),
  ];
}
