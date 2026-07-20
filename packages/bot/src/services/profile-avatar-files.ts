import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function getAvatarDir(dataDir: string) {
  return path.resolve(dataDir, "avatars");
}

function resolveAvatarFile(dataDir: string, filePath: string) {
  const avatarDir = getAvatarDir(dataDir);
  const resolved = path.resolve(dataDir, filePath);
  if (path.dirname(resolved) !== avatarDir) {
    throw new Error("Invalid profile avatar path");
  }
  return resolved;
}

async function unlinkIfPresent(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

export async function removeProfileAvatarFile(dataDir: string, filePath: string) {
  await unlinkIfPresent(resolveAvatarFile(dataDir, filePath));
}

export async function cleanupProfileAvatarFiles(
  dataDir: string,
  telegramId: number,
  keepPath?: string,
) {
  const avatarDir = getAvatarDir(dataDir);
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(avatarDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  const keepName = keepPath ? path.basename(resolveAvatarFile(dataDir, keepPath)) : null;
  const prefix = `${telegramId}-`;
  const legacyName = `${telegramId}.jpg`;
  await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name !== keepName &&
          (entry.name === legacyName ||
            (entry.name.startsWith(prefix) &&
              (entry.name.endsWith(".jpg") || entry.name.endsWith(".tmp")))),
      )
      .map((entry) => unlinkIfPresent(path.join(avatarDir, entry.name))),
  );
}

export async function cleanupBotAvatarFiles(dataDir: string) {
  try {
    await fs.rm(getAvatarDir(dataDir), { recursive: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
