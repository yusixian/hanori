import { client } from "@/lib/client";
import type {
  PluginBotState,
  PluginBotUpdate,
  PluginCatalogEntry,
  PluginInstallRequest,
} from "@cos-tool-bot/shared";

export class PluginRequestError extends Error {
  constructor(readonly conflict: boolean) {
    super("Plugin request failed");
  }
}

async function result<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { ok: boolean; data?: T };
  if (!response.ok || !body.ok) throw new PluginRequestError(response.status === 409);
  return body.data as T;
}

export const pluginsApi = {
  async catalog(): Promise<PluginCatalogEntry[]> {
    return result(await client.api.plugins.$get());
  },
  async bots(): Promise<Array<{ id: string; name: string }>> {
    const bots: Array<{ id: string; name: string }> = [];
    let page = 1;
    let total = Infinity;
    while (bots.length < total) {
      const response = await client.api.bots.$get({ query: { page: String(page), limit: "100" } });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new PluginRequestError(false);
      bots.push(...body.data.map(({ id, name }) => ({ id, name })));
      total = body.total;
      if (body.data.length === 0) break;
      page++;
    }
    return bots;
  },
  async install(request: PluginInstallRequest): Promise<PluginCatalogEntry> {
    return result(await client.api.plugins.install.$post({ json: request }));
  },
  async update(id: string, commit: string, expectedRevision: number): Promise<PluginCatalogEntry> {
    return result(
      await client.api.plugins[":id"].update.$post({
        param: { id },
        json: { commit, expectedRevision },
      }),
    );
  },
  async rollback(id: string, expectedRevision: number): Promise<PluginCatalogEntry> {
    return result(
      await client.api.plugins[":id"].rollback.$post({
        param: { id },
        json: { expectedRevision },
      }),
    );
  },
  async remove(id: string, expectedRevision: number): Promise<void> {
    await result(
      await client.api.plugins[":id"].$delete({ param: { id }, json: { expectedRevision } }),
    );
  },
  async botState(id: string, botId: string): Promise<PluginBotState> {
    return result(await client.api.plugins[":id"].bots[":botId"].$get({ param: { id, botId } }));
  },
  async saveBot(id: string, botId: string, update: PluginBotUpdate): Promise<PluginBotState> {
    return result(
      await client.api.plugins[":id"].bots[":botId"].$patch({
        param: { id, botId },
        json: update,
      }),
    );
  },
  async test(id: string, botId: string): Promise<{ success: boolean }> {
    return result(
      await client.api.plugins[":id"].bots[":botId"].test.$post({ param: { id, botId } }),
    );
  },
};
export type PluginsApi = typeof pluginsApi;
