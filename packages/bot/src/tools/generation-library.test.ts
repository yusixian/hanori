import type { GenerationLibraryActor, GenerationLibraryPort } from "@cos-tool-bot/shared";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createGenerationLibraryTools } from "./generation-library.js";

type ExecutableTool = {
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

const actor: GenerationLibraryActor = {
  botId: "bot-1",
  source: "telegram",
  telegramUserId: 42,
  isAdmin: false,
};

function execute(tool: Tool, input: Record<string, unknown>) {
  return (tool as unknown as ExecutableTool).execute(input);
}

describe("generation library tools", () => {
  it("disables query-hit persistence for read-only unified search", async () => {
    const listCharacters = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const tools = createGenerationLibraryTools({
      port: { listCharacters } as unknown as GenerationLibraryPort,
      getActor: () => actor,
      readOnly: true,
      trackSearchHits: false,
    });
    await execute(tools.search_generation_characters!, { search: "白发", page: 1, limit: 10 });
    expect(listCharacters).toHaveBeenCalledWith(
      actor,
      { search: "白发", page: 1, limit: 10 },
      false,
    );
  });
  it("counts model character searches while identifying results as stored data", async () => {
    const listCharacters = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const port = { listCharacters } as unknown as GenerationLibraryPort;
    const tools = createGenerationLibraryTools({ port, getActor: () => actor });

    await expect(
      execute(tools.search_generation_characters!, { search: "白发", page: 1, limit: 10 }),
    ).resolves.toEqual({
      source: "local_generation_library",
      freshness: "stored",
      data: [],
      total: 0,
    });
    expect(listCharacters).toHaveBeenCalledWith(
      actor,
      { search: "白发", page: 1, limit: 10 },
      true,
    );
  });

  it("keeps asset mutation tools admin-only and rejects cross-user bindings before the port", async () => {
    const setBinding = vi.fn();
    const port = { setBinding } as unknown as GenerationLibraryPort;
    const tools = createGenerationLibraryTools({ port, getActor: () => actor });

    expect(tools.save_prompt_asset).toBeUndefined();
    expect(tools.delete_prompt_asset).toBeUndefined();
    await expect(
      execute(tools.set_character_binding!, {
        telegramId: 99,
        characterId: 7,
        relation: "representation",
        isDefault: true,
      }),
    ).resolves.toMatchObject({ error: expect.any(String) });
    expect(setBinding).not.toHaveBeenCalled();
  });

  it("lets the service apply privacy rules when reading another person's bindings", async () => {
    const getBindings = vi.fn().mockResolvedValue([]);
    const port = { getBindings } as unknown as GenerationLibraryPort;
    const tools = createGenerationLibraryTools({ port, getActor: () => actor });

    await expect(execute(tools.get_character_bindings!, { telegramId: 99 })).resolves.toMatchObject(
      { telegramId: 99, bindings: [] },
    );
    expect(getBindings).toHaveBeenCalledWith(actor, 99);
  });

  it("exposes only searches and binding reads in read-only contexts", () => {
    const adminActor = { ...actor, isAdmin: true };
    const tools = createGenerationLibraryTools({
      port: {} as GenerationLibraryPort,
      getActor: () => adminActor,
      readOnly: true,
    });

    expect(Object.keys(tools).sort()).toEqual(
      ["get_character_bindings", "search_generation_characters", "search_prompt_assets"].sort(),
    );
  });

  it("uses the trusted actor identity for self bindings", async () => {
    const setBinding = vi.fn().mockResolvedValue(undefined);
    const port = { setBinding } as unknown as GenerationLibraryPort;
    const tools = createGenerationLibraryTools({ port, getActor: () => actor });

    await execute(tools.set_character_binding!, {
      characterId: 7,
      relation: "favorite",
      isDefault: false,
    });

    expect(setBinding).toHaveBeenCalledWith(actor, 42, {
      characterId: 7,
      relation: "favorite",
      isDefault: false,
    });
  });
});
