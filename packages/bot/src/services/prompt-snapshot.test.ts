import { describe, expect, it, vi } from "vitest";
import type { PromptSnapshot } from "@cos-tool-bot/shared";
import { capturePromptConfig } from "./prompt-snapshot.js";
import { createFileTools } from "../tools/file-tools.js";
import { createSkillTools } from "../tools/skills.js";
import { assemblePromptPreview } from "./context-assembler.js";
const snapshot = (word: string): PromptSnapshot => ({
  systemPrompt: word,
  behavioralPrompt: `behavior ${word}`,
  groupBehavioralPrompt: `group ${word}`,
  maxInjectionBytes: 1024,
  files: [
    { name: "IDENTITY.md", content: word, enabled: true },
    { name: "REFERENCE.md", content: `reference ${word}`, enabled: false },
  ],
  skills: [
    {
      id: "custom",
      name: "fixture",
      displayName: "Fixture",
      description: "Fixture",
      summary: "Fixture",
      source: "custom",
      digest: word,
      instructions: `skill ${word}`,
      resources: { "ref.md": `resource ${word}` },
      enabled: true,
    },
  ],
});
const execute = async (tool: any, input: unknown) =>
  tool.execute(input, { toolCallId: "test", messages: [] });
describe("prompt turn snapshots", () => {
  it("keeps an admitted turn and its later file/Skill calls on one version while new turns switch", async () => {
    let active = { id: "old", snapshot: snapshot("old") };
    const getPromptSnapshot = vi.fn(async () => active);
    const base = {
      systemPrompt: "legacy",
      model: "current-model",
      apiKey: "current-secret",
      toolPermissions: ["read_file"],
      dataFiles: {
        dataDir: "/tmp/prompt-fixture",
        injectableFiles: new Set<string>(),
        loadFiles: async () => [],
      },
      getPromptSnapshot,
    };
    const old = await capturePromptConfig(base);
    active = { id: "new", snapshot: snapshot("new") };
    const next = await capturePromptConfig(base);
    expect(old.systemPrompt).toBe("old");
    expect(next.systemPrompt).toBe("new");
    expect(old.model).toBe("current-model");
    expect(old.apiKey).toBe("current-secret");
    expect(old.toolPermissions).toBe(base.toolPermissions);
    expect(await old.dataFiles.loadFiles()).toEqual([{ name: "IDENTITY.md", content: "old" }]);
    const files = createFileTools({
      ...old.dataFiles,
      protectedFiles: old.dataFiles.injectableFiles,
    });
    expect(await execute(files.read_file, { path: "./REFERENCE.md" })).toMatchObject({
      content: "reference old",
    });
    expect(
      await execute(files.write_file, { path: "./IDENTITY.md", content: "mixed" }),
    ).toHaveProperty("error");
    expect(await execute(files.delete_file, { path: "IDENTITY.md" })).toHaveProperty("error");
    const skills = createSkillTools({
      skills: old.skills ?? [],
      hasImageGeneration: false,
      hasWebSearch: false,
    });
    expect(
      await execute(skills.load_skill, { skill: "fixture", resource: "ref.md" }),
    ).toMatchObject({ content: "resource old" });
    expect(getPromptSnapshot).toHaveBeenCalledTimes(2);
  });
  it("keeps unversioned deployments compatible and does not load files before a turn needs them", async () => {
    const loadFiles = vi.fn();
    const base = {
      systemPrompt: "legacy",
      dataFiles: { dataDir: "/tmp", injectableFiles: new Set<string>(), loadFiles },
      getPromptSnapshot: async () => null,
    };
    const captured = await capturePromptConfig(base);
    expect(captured.systemPrompt).toBe("legacy");
    expect(captured.dataFiles).toBe(base.dataFiles);
    expect(loadFiles).not.toHaveBeenCalled();
  });
  it("includes the full memory policy once without changing available tools", async () => {
    const preview = await assemblePromptPreview({
      systemPrompt: "Fixture",
      isPrivate: true,
      memoryEnabled: false,
      botMemoryEnabled: true,
    });
    const memory = preview.trace.sections.filter(
      (section) => section.id === "static.bot-memory-tools",
    );
    expect(memory).toHaveLength(1);
    expect(preview.fullPrompt).not.toContain("长期记忆工具:");
    expect(preview.fullPrompt).toContain("save_memory");
    expect(preview.fullPrompt).toContain("delete_memory");
  });
});
