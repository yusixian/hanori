import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDataFilesLoader } from "./data-files-loader.js";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("./file-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./file-validation.js")>()),
  getDataDir: () => state.directory,
}));
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  if (state.directory) await rm(state.directory, { recursive: true, force: true });
  state.directory = "";
});

it("preserves a concurrent successful cache when an earlier read fails later", async () => {
  const directory = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  await writeFile(join(directory, "IDENTITY.md"), "current");
  const loader = await createDataFilesLoader("fixture", {
    injectableFiles: ["IDENTITY.md"],
  });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let releaseRead!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  vi.mocked(readFile).mockImplementationOnce(async () => {
    markEntered();
    await release;
    throw new Error("read failed");
  });
  const earlier = loader.loadFiles();
  try {
    await entered;
    const expected = [{ name: "IDENTITY.md", content: "current" }];
    expect(await loader.loadFiles()).toEqual(expected);
    await writeFile(join(directory, "IDENTITY.md"), "after");
    releaseRead();
    expect(await earlier).toEqual([]);
    expect(await loader.loadFiles()).toEqual(expected);
    expect(readFile).toHaveBeenCalledTimes(2);
  } finally {
    releaseRead();
    await earlier;
  }
});
async function fixture() {
  state.directory = await mkdtemp(join(tmpdir(), "injected-files-"));
  return state.directory;
}

it.each(["missing-target", "directory-entry"])(
  "keeps readable files and retries a failed %s",
  async (failure) => {
    const directory = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    await writeFile(join(directory, "IDENTITY.md"), "identity");
    if (failure === "missing-target") await symlink("missing.md", join(directory, "SOUL.md"));
    else await mkdir(join(directory, "SOUL.md"));
    await writeFile(join(directory, "NOTES.md"), "notes");
    const loader = await createDataFilesLoader("fixture", {
      injectableFiles: ["NOTES.md", "SOUL.md", "IDENTITY.md"],
    });
    expect(await loader.loadFiles()).toEqual([
      { name: "IDENTITY.md", content: "identity" },
      { name: "NOTES.md", content: "notes" },
    ]);
    await rm(join(directory, "SOUL.md"), { recursive: true });
    await writeFile(join(directory, "SOUL.md"), "recovered");
    expect(await loader.loadFiles()).toEqual([
      { name: "IDENTITY.md", content: "identity" },
      { name: "SOUL.md", content: "recovered" },
      { name: "NOTES.md", content: "notes" },
    ]);
  },
);

it("preserves successful cache expiry, priority and UTF-8 byte budgets", async () => {
  const directory = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.parse("2026-10-10T00:00:00Z");
  vi.setSystemTime(now);
  await writeFile(join(directory, "IDENTITY.md"), "中");
  await writeFile(join(directory, "SOUL.md"), "🙂");
  await writeFile(join(directory, "NOTES.md"), "extra");
  const loader = await createDataFilesLoader("fixture", {
    injectableFiles: ["NOTES.md", "SOUL.md", "IDENTITY.md"],
    maxTotalSize: 7,
  });
  const expected = [
    { name: "IDENTITY.md", content: "中" },
    { name: "SOUL.md", content: "🙂" },
  ];
  expect(await loader.loadFiles()).toEqual(expected);
  await writeFile(join(directory, "IDENTITY.md"), "new");
  expect(await readFile(join(directory, "IDENTITY.md"), "utf8")).toBe("new");
  expect(await loader.loadFiles()).toEqual(expected);
  vi.setSystemTime(now + 30_000);
  expect(await loader.loadFiles()).toEqual([
    { name: "IDENTITY.md", content: "new" },
    { name: "SOUL.md", content: "🙂" },
  ]);
});

it("reloads successful prompt preview reads when caching is disabled", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "IDENTITY.md"), "before");
  const loader = await createDataFilesLoader("fixture", {
    injectableFiles: ["IDENTITY.md"],
    cacheTtlMs: 0,
  });
  expect(await loader.loadFiles()).toEqual([{ name: "IDENTITY.md", content: "before" }]);
  await writeFile(join(directory, "IDENTITY.md"), "after");
  expect(await loader.loadFiles()).toEqual([{ name: "IDENTITY.md", content: "after" }]);
});
