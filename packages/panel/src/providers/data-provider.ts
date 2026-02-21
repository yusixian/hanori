import type { DataProvider } from "@refinedev/core";
import { client } from "@/lib/client";

export const dataProvider: DataProvider = {
  getList: async ({ resource, pagination, filters }) => {
    if (resource === "logs") {
      const page = pagination?.current ?? 1;
      const limit = pagination?.pageSize ?? 50;

      const levelFilter = filters?.find((f) => "field" in f && f.field === "level");
      const level = levelFilter && "value" in levelFilter ? (levelFilter.value as string) : undefined;

      const query: Record<string, string> = {
        page: String(page),
        limit: String(limit),
      };
      if (level) query.level = level;

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

    throw new Error(`Resource "${resource}" not supported`);
  },

  getOne: async () => {
    throw new Error("Not implemented");
  },

  create: async () => {
    throw new Error("Not implemented");
  },

  update: async () => {
    throw new Error("Not implemented");
  },

  deleteOne: async () => {
    throw new Error("Not implemented");
  },

  getApiUrl: () => "/api",
};
