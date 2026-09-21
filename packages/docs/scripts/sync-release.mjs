import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const releaseDirectory = resolve(repositoryRoot, "docs/releases");
const targetDirectory = resolve(packageRoot, "content/docs/changelog");

await mkdir(targetDirectory, { recursive: true });

for await (const entry of glob("v*.md", { cwd: releaseDirectory })) {
  const sourcePath = resolve(releaseDirectory, entry);
  const source = await readFile(sourcePath, "utf8");
  const heading = /^#\s+(.+)$/m.exec(source)?.[1];

  if (!heading) {
    throw new Error(`Release notes must start with an H1 heading: ${sourcePath}`);
  }

  const version = basename(entry, ".md");
  const body = source.replace(/^#\s+.+(?:\r?\n)+/, "");
  const generated = `---
title: ${JSON.stringify(heading)}
description: ${JSON.stringify(`cos-tool-bot ${version} 的功能、可靠性改进与升级说明。`)}
---

${body}`;

  await writeFile(resolve(targetDirectory, `${version}.mdx`), generated);
}
