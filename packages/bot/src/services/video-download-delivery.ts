import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { InputFile, Api } from "grammy";

/** Upload from a bounded file stream; never materialize the video in a Buffer. */
export async function sendLocalVideoFile(
  api: Api,
  chatId: number,
  path: string,
  input: { title: string; durationSeconds: number; threadId?: number; signal: AbortSignal },
): Promise<number> {
  input.signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 50_000_000)
      throw new Error("invalid_video_file");
    const stream = file.createReadStream({ autoClose: false, signal: input.signal });
    try {
      // The bot's normal autoRetry transformer retries ambiguous network failures.
      // A one-shot client prevents duplicate videos after a lost delivery receipt.
      const sent = await new Api(api.token, api.options).sendVideo(
        chatId,
        new InputFile(stream, "video.mp4"),
        {
          caption: input.title.slice(0, 800),
          duration: Math.ceil(input.durationSeconds),
          supports_streaming: true,
          ...(input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
        },
        // grammY types the interoperable signal with its legacy abort-controller package.
        input.signal as Parameters<Api["sendVideo"]>[3],
      );
      return sent.message_id;
    } finally {
      stream.destroy();
    }
  } finally {
    await file.close();
  }
}
