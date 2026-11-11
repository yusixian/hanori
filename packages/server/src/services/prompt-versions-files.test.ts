import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { captureWorkingPrompt } from "./prompt-versions.js";
import { getDataDir } from "../utils/file-validation.js";
vi.mock("../utils/file-validation.js", () => ({ getDataDir: vi.fn() }));
it("captures authored prompt files without importing dynamic notes or reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prompt-version-files-"));
  vi.mocked(getDataDir).mockReturnValue(directory);
  try {
    await Promise.all(
      ["IDENTITY.md", "SOUL.md", "NOTES.md", "report.md"].map((name) =>
        writeFile(join(directory, name), `Synthetic ${name}`),
      ),
    );
    const captured = await captureWorkingPrompt("fixture", null);
    expect(captured.files.map((file) => file.name)).toEqual(["IDENTITY.md", "SOUL.md"]);
    await writeFile(join(directory, "IDENTITY.md"), "Later working copy");
    expect(captured.files[0]?.content).toBe("Synthetic IDENTITY.md");
    expect(
      captured.skills.every((skill) => typeof skill.instructions === "string" && skill.resources),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true });
  }
});
