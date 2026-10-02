import { client } from "@/lib/client";
import type { boundedTranscriptPage, MediaJobView } from "@cos-tool-bot/shared";

export type MediaTranscriptPage = ReturnType<typeof boundedTranscriptPage>;
export interface MediaJobsList {
  data: MediaJobView[];
  available: boolean;
  allowExport: boolean;
}
export class MediaJobsRequestError extends Error {
  constructor() {
    super("Media job request failed");
  }
}
async function result<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { ok: boolean; data?: T };
  if (!response.ok || !body.ok) throw new MediaJobsRequestError();
  return body.data as T;
}
const route = client.api.plugins[":id"].bots[":botId"].jobs;
const param = (botId: string) => ({ id: "hanori.bilibili" as const, botId });
export const mediaJobsApi = {
  async list(botId: string): Promise<MediaJobsList> {
    const response = await route.$get({ param: param(botId) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new MediaJobsRequestError();
    return { data: body.data, available: body.available, allowExport: body.allowExport };
  },
  async cancel(botId: string, jobId: string): Promise<MediaJobView> {
    return result(await route[":jobId"].cancel.$post({ param: { ...param(botId), jobId } }));
  },
  async transcript(
    botId: string,
    jobId: string,
    options: { offset: number; limit: number; query?: string },
  ): Promise<MediaTranscriptPage> {
    return result(
      await route[":jobId"].transcript.$get({
        param: { ...param(botId), jobId },
        query: {
          offset: String(options.offset),
          limit: String(options.limit),
          ...(options.query ? { query: options.query } : {}),
        },
      }),
    );
  },
  async export(botId: string, jobId: string, format: "srt" | "vtt"): Promise<Blob> {
    const response = await route[":jobId"].export.$post({
      param: { ...param(botId), jobId },
      json: { format, rightsConfirmed: true },
    });
    if (!response.ok) throw new MediaJobsRequestError();
    return response.blob();
  },
};
export type MediaJobsApi = typeof mediaJobsApi;
