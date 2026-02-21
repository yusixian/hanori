import type { DataProvider } from "@refinedev/core";
import { client } from "@/lib/client";

// Refine DataProvider methods use generics (<TData extends BaseRecord>),
// so concrete types cannot satisfy TData. The `as any` casts on return
// data are unavoidable at this interface boundary.

export const dataProvider: DataProvider = {
  getList: async ({ resource, pagination, filters }) => {
    if (resource === "logs") {
      const page = pagination?.current ?? 1;
      const limit = pagination?.pageSize ?? 50;

      const levelFilter = filters?.find((f) => "field" in f && f.field === "level");
      const level =
        levelFilter && "value" in levelFilter ? (levelFilter.value as string) : undefined;

      const botIdFilter = filters?.find((f) => "field" in f && f.field === "botId");
      const botId =
        botIdFilter && "value" in botIdFilter ? (botIdFilter.value as string) : undefined;

      const query: Record<string, string> = {
        page: String(page),
        limit: String(limit),
      };
      if (level) query.level = level;
      if (botId) query.botId = botId;

      const res = await client.api.logs.$get({ query });
      const json = await res.json();

      if (json.ok) {
        return {
          data: json.data as any[],
          total: json.total,
        };
      }
      throw new Error("Failed to fetch logs");
    }

    if (resource === "bots") {
      const page = pagination?.current ?? 1;
      const limit = pagination?.pageSize ?? 20;

      const res = await client.api.bots.$get({
        query: { page: String(page), limit: String(limit) },
      });
      const json = await res.json();
      if (json.ok) {
        return {
          data: json.data as any[],
          total: json.total,
        };
      }
      throw new Error("Failed to fetch bots");
    }

    throw new Error(`Resource "${resource}" not supported`);
  },

  getOne: async ({ resource, id }) => {
    if (resource === "bots") {
      const res = await client.api.bots[":botId"].$get({ param: { botId: String(id) } });
      const json = await res.json();
      if (json.ok) {
        return { data: json.data as any };
      }
      throw new Error("Bot not found");
    }
    throw new Error(`Resource "${resource}" not supported`);
  },

  create: async ({ resource, variables }) => {
    if (resource === "bots") {
      const vars = variables as {
        name: string;
        token: string;
        adminChatIds: number[];
        isActive: boolean;
      };
      const res = await client.api.bots.$post({ json: vars });
      const json = await res.json();
      if (json.ok) {
        return { data: json.data as any };
      }
      throw new Error("Failed to create bot");
    }
    throw new Error(`Resource "${resource}" not supported`);
  },

  update: async ({ resource, id, variables }) => {
    if (resource === "bots") {
      const vars = variables as {
        name?: string;
        token?: string;
        adminChatIds?: number[];
        isActive?: boolean;
      };
      const res = await client.api.bots[":botId"].$put({
        param: { botId: String(id) },
        json: vars,
      });
      const json = await res.json();
      if (json.ok) {
        return { data: json.data as any };
      }
      throw new Error("Failed to update bot");
    }
    throw new Error(`Resource "${resource}" not supported`);
  },

  deleteOne: async ({ resource, id }) => {
    if (resource === "bots") {
      const res = await client.api.bots[":botId"].$delete({
        param: { botId: String(id) },
      });
      const json = await res.json();
      if (json.ok) {
        return { data: {} as any };
      }
      throw new Error("Failed to delete bot");
    }
    throw new Error(`Resource "${resource}" not supported`);
  },

  getApiUrl: () => "/api",
};
