import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("shared declarations survive slow source loading and a clean rebuild", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "shared-build-"));
  try {
    const shared = join(scratch, "packages/shared");
    await cp(join(root, "packages/shared/src"), join(shared, "src"), { recursive: true });
    for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json"])
      await cp(join(root, "packages/shared", file), join(shared, file));
    await cp(join(root, "tsconfig.base.json"), join(scratch, "tsconfig.base.json"));
    await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    await symlink(join(root, "packages/shared/node_modules"), join(shared, "node_modules"), "dir");
    // The old DTS plugin resolves a virtual declaration after only 200 ms, before this load finishes.
    await writeFile(
      join(shared, "tsdown.config.ts"),
      `
      import { readFile } from 'node:fs/promises';
      export default {
        plugins: [{ name: 'slow-source-fixture', async load(id) {
          if (id.endsWith('/rss.ts')) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return readFile(id, 'utf8');
          }
        } }]
      };
    `,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await rm(join(shared, "dist"), { recursive: true, force: true });
      await exec("pnpm", ["build"], { cwd: shared, timeout: 30_000 });
      for (const entry of ["index", "file-validation", "file-reader", "rss", "mcp", "skills"])
        expect(await readFile(join(shared, `dist/${entry}.d.ts`), "utf8")).not.toBe("");
      for (const entry of ["index", "file-validation", "file-reader"]) {
        expect(await readFile(join(shared, `dist/${entry}.js`), "utf8")).not.toBe("");
        expect(
          JSON.parse(await readFile(join(shared, `dist/${entry}.js.map`), "utf8")).version,
        ).toBe(3);
        expect(
          JSON.parse(await readFile(join(shared, `dist/${entry}.d.ts.map`), "utf8")).version,
        ).toBe(3);
      }
    }
    await writeFile(
      join(shared, "consumer.ts"),
      `
      import type { RssCollectionRecord, McpServerRecord, BotCustomSkillStored } from './dist/index.js';
      const ids: Array<RssCollectionRecord['id'] | McpServerRecord['id'] | BotCustomSkillStored['id']> = [1, 'skill'];
      void ids;
    `,
    );
    await exec(
      "pnpm",
      [
        "exec",
        "tsc",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "consumer.ts",
      ],
      { cwd: shared, timeout: 30_000 },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 90_000);
