import type { CrudFilter } from "@refinedev/core";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  getBots: vi.fn(),
}));

vi.mock("@/lib/client", () => ({
  client: { api: { logs: { $get: mocks.getLogs }, bots: { $get: mocks.getBots } } },
}));

import { dataProvider } from "./data-provider";

beforeEach(() => {
  mocks.getLogs.mockReset();
  mocks.getLogs.mockResolvedValue({
    json: async () => ({ ok: true, data: [], total: 0 }),
  });
  mocks.getBots.mockReset();
  mocks.getBots.mockResolvedValue({
    json: async () => ({ ok: true, data: [], total: 0 }),
  });
});

test("forwards the trimmed Bot name search with pagination and omits an empty search", async () => {
  await dataProvider.getList({
    resource: "bots",
    pagination: { current: 3, pageSize: 12 },
    filters: [{ field: "search", operator: "eq", value: "  Bot 125  " }],
  });
  expect(mocks.getBots).toHaveBeenLastCalledWith({
    query: { page: "3", limit: "12", search: "Bot 125" },
  });

  await dataProvider.getList({
    resource: "bots",
    pagination: { current: 1, pageSize: 12 },
    filters: [],
  });
  expect(mocks.getBots).toHaveBeenLastCalledWith({ query: { page: "1", limit: "12" } });
});

test("forwards every log filter to the history request", async () => {
  const filters: CrudFilter[] = [
    { field: "level", operator: "eq", value: "error" },
    { field: "botId", operator: "eq", value: "00000000-0000-4000-8000-000000000001" },
    { field: "search", operator: "eq", value: "timeout" },
    { field: "chatId", operator: "eq", value: "-100123" },
    { field: "correlationId", operator: "eq", value: "turn-abc" },
  ];

  await dataProvider.getList({
    resource: "logs",
    pagination: { current: 2, pageSize: 25 },
    filters,
  });

  expect(mocks.getLogs).toHaveBeenCalledWith({
    query: {
      page: "2",
      limit: "25",
      level: "error",
      botId: "00000000-0000-4000-8000-000000000001",
      search: "timeout",
      chatId: "-100123",
      correlationId: "turn-abc",
    },
  });
});
