import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PROFILE_AVATAR_BYTES,
  readProfileAvatarFile,
  removeProfileAvatarFile,
} from "./profile-avatar-files.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("removeProfileAvatarFile", () => {
  it("deletes a safe avatar and treats a missing file as already removed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cos-tool-bot-privacy-"));
    tempRoots.push(root);
    await mkdir(path.join(root, "avatars"));
    await writeFile(path.join(root, "avatars", "42.jpg"), "avatar");

    await expect(removeProfileAvatarFile(root, "avatars/42.jpg")).resolves.toBeUndefined();
    await expect(removeProfileAvatarFile(root, "avatars/42.jpg")).resolves.toBeUndefined();
    await expect(access(path.join(root, "avatars", "42.jpg"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const absolutePath = path.join(root, "avatars", "42-current.jpg");
    await writeFile(absolutePath, "avatar");
    await expect(removeProfileAvatarFile(root, absolutePath)).resolves.toBeUndefined();
    await expect(access(absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects paths outside the avatar directory without deleting them", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "cos-tool-bot-privacy-"));
    tempRoots.push(parent);
    const dataDir = path.join(parent, "bot");
    await mkdir(dataDir);
    const outside = path.join(parent, "outside.jpg");
    await writeFile(outside, "avatar");

    await expect(removeProfileAvatarFile(dataDir, "../outside.jpg")).rejects.toThrow(
      "Invalid profile avatar path",
    );
    await expect(access(outside)).resolves.toBeUndefined();
  });
});

describe("readProfileAvatarFile", () => {
  async function createRoot() {
    const root = await mkdtemp(path.join(os.tmpdir(), "cos-tool-bot-avatar-read-"));
    tempRoots.push(root);
    await mkdir(path.join(root, "avatars"));
    return root;
  }

  it.each([
    ["jpeg", "image/jpeg", "jpg"],
    ["png", "image/png", "png"],
    ["webp", "image/webp", "webp"],
  ] as const)("reads a valid %s owned by the requested profile", async (format, mediaType, ext) => {
    const root = await createRoot();
    const data = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#336699" },
    })
      .toFormat(format)
      .toBuffer();
    const relativePath = `avatars/42-current.${ext}`;
    await writeFile(path.join(root, relativePath), data);

    await expect(readProfileAvatarFile(root, relativePath, 42)).resolves.toEqual({
      data: new Uint8Array(data),
      mediaType,
    });
  });

  it("rejects traversal, another profile's file, and symbolic links", async () => {
    const root = await createRoot();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.jpg`);
    tempRoots.push(outside);
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    await writeFile(outside, image);
    await writeFile(path.join(root, "avatars", "43-current.jpg"), image);
    await symlink(outside, path.join(root, "avatars", "42-current.jpg"));

    await expect(readProfileAvatarFile(root, "../outside.jpg", 42)).rejects.toThrow();
    await expect(readProfileAvatarFile(root, "avatars/43-current.jpg", 42)).rejects.toThrow();
    await expect(readProfileAvatarFile(root, "avatars/42-current.jpg", 42)).rejects.toThrow();
  });

  it("rejects an avatars directory symlink that escapes the Bot data directory", async () => {
    const root = await createRoot();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "cos-tool-bot-avatar-outside-"));
    tempRoots.push(outsideDir);
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    await writeFile(path.join(outsideDir, "42-current.jpg"), image);
    await rm(path.join(root, "avatars"), { recursive: true });
    await symlink(outsideDir, path.join(root, "avatars"));

    await expect(readProfileAvatarFile(root, "avatars/42-current.jpg", 42)).rejects.toThrow(
      "Invalid profile avatar directory",
    );
  });

  it("rejects empty, oversized, and invalid image data", async () => {
    const root = await createRoot();
    const avatarDir = path.join(root, "avatars");
    await writeFile(path.join(avatarDir, "42-empty.jpg"), new Uint8Array());
    await writeFile(
      path.join(avatarDir, "42-large.jpg"),
      new Uint8Array(MAX_PROFILE_AVATAR_BYTES + 1),
    );
    await writeFile(path.join(avatarDir, "42-invalid.jpg"), "not an image");

    await expect(readProfileAvatarFile(root, "avatars/42-empty.jpg", 42)).rejects.toThrow();
    await expect(readProfileAvatarFile(root, "avatars/42-large.jpg", 42)).rejects.toThrow();
    await expect(readProfileAvatarFile(root, "avatars/42-invalid.jpg", 42)).rejects.toThrow();
  });

  it("rejects a non-regular cache entry without reading it", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "avatars", "42-current.jpg"));

    await expect(readProfileAvatarFile(root, "avatars/42-current.jpg", 42)).rejects.toThrow(
      "Invalid profile avatar file",
    );
  });
});
