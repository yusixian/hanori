import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { botFilesRoutes } from "./bot-files.js";
import { BOT_DATA_TEMPLATES } from "../templates/bot-data-templates.js";

const state = vi.hoisted(() => ({ dataDir: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock("../utils/file-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/file-validation.js")>()),
  getDataDir: () => state.dataDir,
}));

async function fixture(injectableFiles?: string[]) {
  state.dataDir = await mkdtemp(join(tmpdir(), "bot-files-download-"));
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [
          { id: "bot-fixture", aiConfig: { dataFilesConfig: { injectableFiles } } },
        ],
      }),
    }),
  };
  const botPool = { withAiConfigLock: async (_id: string, callback: () => unknown) => callback() };
  return new Hono().route("/api/bots", botFilesRoutes(db as never, botPool as never));
}

afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  if (state.dataDir) await rm(state.dataDir, { recursive: true, force: true });
  state.dataDir = "";
});

it("initializes missing templates without replacing a concurrently created file", async () => {
  const app = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const name = Object.keys(BOT_DATA_TEMPLATES)[0]!;
  vi.mocked(writeFile).mockImplementationOnce(async (file, content, options) => {
    await actual.writeFile(file, "concurrent owner content");
    return actual.writeFile(file, content, options);
  });
  const response = await app.request("/api/bots/bot-fixture/files-init", { method: "POST" });
  expect(response.status).toBe(200);
  expect(await readFile(join(state.dataDir, name), "utf8")).toBe("concurrent owner content");
  expect(await response.json()).toEqual({
    ok: true,
    created: Object.keys(BOT_DATA_TEMPLATES).filter((entry) => entry !== name),
  });
  for (const [entry, content] of Object.entries(BOT_DATA_TEMPLATES)) {
    if (entry !== name) expect(await readFile(join(state.dataDir, entry), "utf8")).toBe(content);
  }
  const repeated = await app.request("/api/bots/bot-fixture/files-init", { method: "POST" });
  expect(await repeated.json()).toEqual({ ok: true, created: [] });
});

it("does not follow an existing dangling template symlink during initialization", async () => {
  const app = await fixture();
  await symlink("missing-target.md", join(state.dataDir, "IDENTITY.md"));
  const response = await app.request("/api/bots/bot-fixture/files-init", { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, created: ["SOUL.md", "NOTES.md"] });
  await expect(readFile(join(state.dataDir, "missing-target.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("reports template write failures instead of treating them as existing files", async () => {
  const app = await fixture();
  const error = Object.assign(new Error("synthetic write denied"), { code: "EACCES" });
  const onError = vi.fn((_error: Error) => new Response(null, { status: 500 }));
  app.onError(onError);
  vi.mocked(writeFile).mockRejectedValueOnce(error);
  const response = await app.request("/api/bots/bot-fixture/files-init", { method: "POST" });
  expect(response.status).toBe(500);
  expect(onError.mock.calls[0]?.[0]).toBe(error);
  await expect(readFile(join(state.dataDir, "IDENTITY.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

function expectFilename(response: Response, filename: string) {
  const header = response.headers.get("content-disposition")!;
  expect(header.startsWith('attachment; filename="')).toBe(true);
  expect([...header].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127)).toBe(
    true,
  );
  expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(filename);
}

it.each(["个人 记忆.md", 'quoted "notes".md', "notes.md"])(
  "downloads %j with its original bytes and safe filename",
  async (filename) => {
    const app = await fixture();
    await writeFile(join(state.dataDir, filename), "合成文件内容");
    const response = await app.request(
      `/api/bots/bot-fixture/files-raw/${encodeURIComponent(filename)}?download=true`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("合成文件内容");
    expectFilename(response, filename);
  },
);

it("keeps ordinary file previews inline", async () => {
  const app = await fixture();
  await writeFile(join(state.dataDir, "notes.md"), "preview");
  const response = await app.request("/api/bots/bot-fixture/files-raw/notes.md");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("preview");
  expect(response.headers.get("content-disposition")).toBeNull();
});

it("downloads a Unicode directory archive with its allowed entries", async () => {
  const app = await fixture();
  const directory = "个人 文件";
  await mkdir(join(state.dataDir, directory));
  await writeFile(join(state.dataDir, directory, "notes.md"), "synthetic archive content");
  await writeFile(join(state.dataDir, directory, "excluded.exe"), "excluded");
  const response = await app.request(
    `/api/bots/bot-fixture/files-zip?path=${encodeURIComponent(directory)}`,
  );
  expect(response.status).toBe(200);
  expectFilename(response, `${directory}.zip`);
  const archive = Buffer.from(await response.arrayBuffer());
  expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  expect(archive.includes(Buffer.from("notes.md"))).toBe(true);
  expect(archive.includes(Buffer.from("excluded.exe"))).toBe(false);
});

it.each(["进度 100%.md", "notes#1.md", "notes?draft.md", "%2e%2e.md", "%2F.md"])(
  "reads, downloads, edits and deletes the literal filename %j",
  async (filename) => {
    const app = await fixture();
    const diskPath = join(state.dataDir, filename);
    await writeFile(diskPath, "original");
    const encoded = encodeURIComponent(filename);
    const url = `/api/bots/bot-fixture/files/${encoded}`;
    const read = await app.request(url);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ content: "original" });
    const download = await app.request(`/api/bots/bot-fixture/files-raw/${encoded}?download=true`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("original");
    expectFilename(download, filename);
    const update = await app.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "updated" }),
    });
    expect(update.status).toBe(200);
    expect(await readFile(diskPath, "utf-8")).toBe("updated");
    expect((await app.request(url, { method: "DELETE" })).status).toBe(200);
    await expect(readFile(diskPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["%", "%FF.md", "..%2Foutside.md", "%2Ftmp%2Foutside.md"])(
  "rejects malformed or separator-encoded paths %j before filesystem access",
  async (encoded) => {
    const app = await fixture();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await app.request(`/api/bots/bot-fixture/files/${encoded}`, { method });
      expect(response.status).toBe(400);
    }
    expect((await app.request(`/api/bots/bot-fixture/files-raw/${encoded}`)).status).toBe(400);
  },
);

it("preserves nested literal names and rejects traversal outside the data directory", async () => {
  const app = await fixture();
  await mkdir(join(state.dataDir, "目录%2F"));
  await writeFile(join(state.dataDir, "目录%2F", "notes#1.md"), "nested");
  const response = await app.request(
    `/api/bots/bot-fixture/files/${encodeURIComponent("目录%2F")}/${encodeURIComponent("notes#1.md")}`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ content: "nested" });
  // Literal backtracking is normalized by URL parsing before routing.
  expect((await app.request("/api/bots/bot-fixture/files/../../outside.md")).status).not.toBe(200);
});

it("keeps injectable files protected after decoding names and rejects encoded separator aliases", async () => {
  const filename = "记忆%#?.md";
  const app = await fixture([filename, "SOUL.md"]);
  await writeFile(join(state.dataDir, filename), "protected");
  await writeFile(join(state.dataDir, "SOUL.md"), "protected");
  expect(
    (
      await app.request(`/api/bots/bot-fixture/files/${encodeURIComponent(filename)}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(403);
  for (const alias of [".%2FSOUL.md", "sub%2f..%2fSOUL.md"]) {
    expect(
      (await app.request(`/api/bots/bot-fixture/files/${alias}`, { method: "DELETE" })).status,
    ).toBe(400);
  }
  expect(await readFile(join(state.dataDir, filename), "utf-8")).toBe("protected");
  expect(await readFile(join(state.dataDir, "SOUL.md"), "utf-8")).toBe("protected");
});

it.each(["./SOUL.md", "sub/../SOUL.md", "sub//identity.md"])(
  "keeps the injectable batch target protected through path alias %j",
  async (alias) => {
    const app = await fixture(["SOUL.md", "sub/identity.md"]);
    await mkdir(join(state.dataDir, "sub"));
    await writeFile(join(state.dataDir, "SOUL.md"), "protected root");
    await writeFile(join(state.dataDir, "sub/identity.md"), "protected nested");
    await writeFile(join(state.dataDir, "sub/SOUL.md"), "ordinary nested file");
    const response = await app.request("/api/bots/bot-fixture/files-delete-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [alias, "sub/SOUL.md"] }),
    });
    expect(await response.json()).toEqual({ ok: true, deleted: ["sub/SOUL.md"], skipped: [alias] });
    expect(await readFile(join(state.dataDir, "SOUL.md"), "utf8")).toBe("protected root");
    expect(await readFile(join(state.dataDir, "sub/identity.md"), "utf8")).toBe("protected nested");
    await expect(readFile(join(state.dataDir, "sub/SOUL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("protects a single injectable target through repeated directory separators", async () => {
  const app = await fixture(["sub/identity.md"]);
  await mkdir(join(state.dataDir, "sub"));
  await writeFile(join(state.dataDir, "sub/identity.md"), "protected");
  const response = await app.request("/api/bots/bot-fixture/files/sub//identity.md", {
    method: "DELETE",
  });
  expect(response.status).toBe(403);
  expect(await readFile(join(state.dataDir, "sub/identity.md"), "utf8")).toBe("protected");
});

it("preserves percent-encoded ordinary route components", async () => {
  const app = await fixture();
  await writeFile(join(state.dataDir, "notes.md"), "route aliases");
  const response = await app.request("/%61pi/b%6Fts/%62ot-fixture/f%69les/notes.md");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ content: "route aliases" });
});

it.each([null, false, 42, "text", [], {}, { content: null }, { content: 42 }])(
  "rejects invalid file update body %j without changing the file",
  async (body) => {
    const app = await fixture();
    const filePath = join(state.dataDir, "notes.md");
    await writeFile(filePath, "original");
    const response = await app.request("/api/bots/bot-fixture/files/notes.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Content must be a string" });
    expect(await readFile(filePath, "utf-8")).toBe("original");
  },
);

it("rejects malformed JSON and still accepts empty content with extra fields", async () => {
  const app = await fixture();
  const filePath = join(state.dataDir, "notes.md");
  await writeFile(filePath, "original");
  const url = "/api/bots/bot-fixture/files/notes.md";
  const invalid = await app.request(url, { method: "PUT", body: "{" });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ ok: false, error: "Invalid JSON body" });
  expect(await readFile(filePath, "utf-8")).toBe("original");
  const valid = await app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "", extra: true }),
  });
  expect(valid.status).toBe(200);
  expect(await readFile(filePath, "utf-8")).toBe("");
});

it("returns an empty cancellation response when ZIP preparation is already aborted", async () => {
  const app = await fixture();
  const controller = new AbortController();
  controller.abort();
  const response = await app.request("/api/bots/bot-fixture/files-zip", {
    signal: controller.signal,
  });
  expect(response.status).toBe(499);
  expect(await response.text()).toBe("");
});

it("keeps other files visible when an entry no longer has a stat target", async () => {
  const app = await fixture(["keep.md"]);
  await mkdir(join(state.dataDir, "folder"));
  await writeFile(join(state.dataDir, "keep.md"), "retained");
  // A dangling entry produces the same ENOENT as deletion between readdir and stat.
  await symlink("missing.md", join(state.dataDir, "removed.md"));
  const response = await app.request("/api/bots/bot-fixture/files");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    files: [
      { name: "folder", path: "folder", size: 0, type: "dir" },
      { name: "keep.md", path: "keep.md", size: 8, type: "file" },
    ],
    injection: { injectableFiles: ["keep.md"] },
  });
});

it.each(["files", "files-raw"])(
  "preserves %s size errors and reports actual UTF-8 byte size",
  async (route) => {
    const app = await fixture();
    const file = join(state.dataDir, "bounded.md");
    const url = `/api/bots/bot-fixture/${route}/bounded.md`;
    await writeFile(file, "字幕🙂");
    const normal = await app.request(url);
    expect(normal.status).toBe(200);
    if (route === "files")
      expect(await normal.json()).toMatchObject({ content: "字幕🙂", size: 10 });
    else expect(await normal.text()).toBe("字幕🙂");
    await truncate(file, 20 * 1024 * 1024 + 1);
    const oversized = await app.request(url);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "File too large" });
    await rm(file);
    expect((await app.request(url)).status).toBe(404);
  },
);
