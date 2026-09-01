import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readTrimmed(path) {
  return (await readFile(path, "utf8")).trim();
}

async function resolveGitDirectory() {
  const dotGit = resolve(repositoryRoot, ".git");
  const metadata = await stat(dotGit);
  if (metadata.isDirectory()) return dotGit;
  const pointer = await readTrimmed(dotGit);
  if (!pointer.startsWith("gitdir:")) throw new Error("Unsupported .git pointer");
  return resolve(repositoryRoot, pointer.slice("gitdir:".length).trim());
}

async function resolveGitCommit() {
  const gitDirectory = await resolveGitDirectory();
  const head = await readTrimmed(resolve(gitDirectory, "HEAD"));
  if (SHA_PATTERN.test(head)) return head.toLowerCase();
  if (!head.startsWith("ref:")) throw new Error("Git HEAD is not a commit or ref");

  const ref = head.slice("ref:".length).trim();
  try {
    const looseRef = await readTrimmed(resolve(gitDirectory, ref));
    if (SHA_PATTERN.test(looseRef)) return looseRef.toLowerCase();
  } catch {
    // Fall through to packed-refs.
  }

  const packedRefs = await readTrimmed(resolve(gitDirectory, "packed-refs"));
  for (const line of packedRefs.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue;
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === ref && sha && SHA_PATTERN.test(sha)) return sha.toLowerCase();
  }
  throw new Error(`Unable to resolve Git ref ${ref}`);
}

const override = process.env.APP_VERSION?.trim();
const version =
  override && SHA_PATTERN.test(override) ? override.toLowerCase() : await resolveGitCommit();
await writeFile(resolve(repositoryRoot, "deployment-version"), `${version}\n`, { mode: 0o644 });
process.stdout.write(`Embedded deployment version ${version}\n`);
