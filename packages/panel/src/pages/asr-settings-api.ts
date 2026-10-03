import { authFetch } from "@/lib/client";
import type { AsrSettingsPublic, AsrSettingsUpdate } from "@cos-tool-bot/shared";

export class AsrSettingsRequestError extends Error {
  constructor(readonly conflict: boolean) {
    super("ASR settings request failed");
  }
}
async function read(response: Response): Promise<AsrSettingsPublic> {
  const body = (await response.json()) as { ok?: boolean; data?: AsrSettingsPublic };
  if (!response.ok || !body.ok || !body.data)
    throw new AsrSettingsRequestError(response.status === 409);
  return body.data;
}
export const asrSettingsApi = {
  async get() {
    return read(await authFetch("/api/asr/settings"));
  },
  async save(update: AsrSettingsUpdate) {
    return read(
      await authFetch("/api/asr/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }),
    );
  },
};
