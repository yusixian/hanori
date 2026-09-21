import type { PeopleProfileAvatarMediaType } from "@cos-tool-bot/shared";
import { constants, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";

export const MAX_PROFILE_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_PROFILE_AVATAR_PIXELS = 25_000_000;
const SUPPORTED_AVATAR_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

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

function validateAvatarFilename(filePath: string, telegramId: number) {
  const filename = path.basename(filePath);
  const extension = path.extname(filename).toLowerCase();
  const hasExpectedOwner =
    filename === `${telegramId}.jpg` ||
    (filename.startsWith(`${telegramId}-`) && SUPPORTED_AVATAR_EXTENSIONS.has(extension));
  if (!hasExpectedOwner) throw new Error("Invalid profile avatar path");
}

function toAvatarMediaType(format: string | undefined): PeopleProfileAvatarMediaType {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      throw new Error("Unsupported profile avatar format");
  }
}

export async function readProfileAvatarFile(
  dataDir: string,
  filePath: string,
  telegramId: number,
): Promise<{ data: Uint8Array; mediaType: PeopleProfileAvatarMediaType }> {
  if (path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new Error("Invalid profile avatar path");
  }
  validateAvatarFilename(filePath, telegramId);
  const [realDataDir, realAvatarDir] = await Promise.all([
    fs.realpath(dataDir),
    fs.realpath(getAvatarDir(dataDir)),
  ]);
  if (realAvatarDir !== path.join(realDataDir, "avatars")) {
    throw new Error("Invalid profile avatar directory");
  }
  const resolved = resolveAvatarFile(dataDir, filePath);
  const file = await fs.open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROFILE_AVATAR_BYTES) {
      throw new Error("Invalid profile avatar file");
    }
    const bounded = Buffer.allocUnsafe(MAX_PROFILE_AVATAR_BYTES + 1);
    let length = 0;
    while (length < bounded.byteLength) {
      const { bytesRead } = await file.read(bounded, length, bounded.byteLength - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length <= 0 || length > MAX_PROFILE_AVATAR_BYTES) {
      throw new Error("Invalid profile avatar file");
    }
    const buffer = bounded.subarray(0, length);
    const metadata = await sharp(buffer, {
      failOn: "warning",
      limitInputPixels: MAX_PROFILE_AVATAR_PIXELS,
    }).metadata();
    if (!metadata.width || !metadata.height) throw new Error("Invalid profile avatar image");
    return {
      data: new Uint8Array(buffer),
      mediaType: toAvatarMediaType(metadata.format),
    };
  } finally {
    await file.close();
  }
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
