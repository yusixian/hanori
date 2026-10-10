import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileTools } from "./file-tools.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rmdir: vi.fn(actual.rmdir) };
});
let directory: string | undefined;
afterEach(async () => {
  vi.clearAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function fixture(protectedFiles = ["SOUL.md"]) {
  directory = await mkdtemp(join(tmpdir(), "file-tool-delete-"));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "notes.md"), "delete me");
  const tools = createFileTools({ dataDir: directory, protectedFiles: new Set(protectedFiles) });
  const remove = (path: string) =>
    tools.delete_file!.execute!({ path }, { toolCallId: "test", messages: [] });
  return { root: directory, remove };
}

it("reports deletion success if another writer fills the parent before rmdir", async () => {
  const { root, remove } = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rmdir).mockImplementationOnce(async (path) => {
    await writeFile(join(String(path), "concurrent.md"), "keep me");
    await actual.rmdir(path);
  });
  expect(await remove("nested/notes.md")).toEqual({ ok: true });
  await expect(readFile(join(root, "nested", "notes.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(root, "nested", "concurrent.md"), "utf8")).toBe("keep me");
});

it.each(["EACCES", "ENOENT"])("keeps successful deletion after parent cleanup %s", async (code) => {
  const { root, remove } = await fixture();
  vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error("cleanup failed"), { code }));
  expect(await remove("nested/notes.md")).toEqual({ ok: true });
  await expect(readFile(join(root, "nested", "notes.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("cleans empty parents, preserves the data root, and retains file error results", async () => {
  const { root, remove } = await fixture();
  expect(await remove("nested/notes.md")).toEqual({ ok: true });
  expect(await readdir(root)).toEqual([]);
  expect(await remove("nested/notes.md")).toEqual({ error: "File not found" });
  await writeFile(join(root, "SOUL.md"), "protected");
  expect(await remove("SOUL.md")).toMatchObject({ error: expect.stringContaining("protected") });
  expect(await readFile(join(root, "SOUL.md"), "utf8")).toBe("protected");
  expect(await remove("../outside.md")).toEqual({ error: "Invalid path" });
});

it.each([
  ["nested/notes.md", "nested/notes.md"],
  ["nested//notes.md", "nested/notes.md"],
  ["nested/notes.md", "nested/../nested/notes.md"],
  ["./SOUL.md", "SOUL.md"],
])("protects configured target %s when deleting %s", async (configured, requested) => {
  const { root, remove } = await fixture([configured]);
  await writeFile(join(root, "SOUL.md"), "identity");
  expect(await remove(requested)).toMatchObject({ error: expect.stringContaining("protected") });
  expect(await readFile(join(root, requested), "utf8")).toBe(
    requested === "SOUL.md" ? "identity" : "delete me",
  );
});

it("allows deleting an unprotected nested file with the same name as a protected root file", async () => {
  const { root, remove } = await fixture();
  await writeFile(join(root, "SOUL.md"), "identity");
  await writeFile(join(root, "nested", "SOUL.md"), "ordinary note");
  expect(await remove("nested/SOUL.md")).toEqual({ ok: true });
  await expect(readFile(join(root, "nested", "SOUL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(root, "SOUL.md"), "utf8")).toBe("identity");
  expect(await remove("nested/../SOUL.md")).toMatchObject({
    error: expect.stringContaining("protected"),
  });
});
