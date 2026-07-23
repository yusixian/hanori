import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeProfileAvatarFile } from "./profile-avatar-files.js";

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
