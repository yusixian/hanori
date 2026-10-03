import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoDownloadCache, type VideoDownloadLease } from "./cache.js";

describe("video download disk cache", () => {
  let temporary: string;
  let root: string;
  let now: number;
  let free: number;
  let cache: VideoDownloadCache;
  const policy = { reservedBytes: 100, maxCacheBytes: 1000, minFreeDiskBytes: 50 };

  function createCache() {
    return new VideoDownloadCache({
      root,
      now: () => now,
      statfs: async () => ({ bavail: BigInt(free), bsize: 1n }),
    });
  }

  async function ready(lease: VideoDownloadLease, bytes = 20, ttlMs = 100) {
    await writeFile(lease.filePath("output.mp4"), Buffer.alloc(bytes));
    return lease.commit("output.mp4", { ttlMs, maxFileBytes: 100 });
  }

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "video-cache-test-"));
    root = join(temporary, "cache");
    now = 1000;
    free = 10_000;
    cache = createCache();
  });

  afterEach(async () => {
    cache.stopSweep();
    vi.useRealTimers();
    await rm(temporary, { recursive: true, force: true });
  });

  it("retains only the final artifact until its individual TTL expires", async () => {
    const id = randomUUID();
    const lease = await cache.reserve({ ...policy, id });
    expect(lease.id).toBe(id);
    await writeFile(lease.filePath("video.mp4"), Buffer.alloc(30));
    await writeFile(lease.filePath("audio.m4a"), Buffer.alloc(10));
    const artifact = await ready(lease);
    expect(artifact).toEqual({
      id,
      path: lease.filePath("output.mp4"),
      bytes: 20,
      expiresAt: 1100,
    });
    expect((await readdir(dirname(artifact.path))).sort()).toEqual(["metadata.json", "output.mp4"]);
    await lease.release({ retain: true });
    now = 1099;
    expect(await cache.inspect(id)).toEqual(artifact);
    now = 1100;
    await cache.sweep();
    expect(await cache.inspect(id)).toBeNull();
    await expect(lstat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims unfinished jobs and preserves valid completed jobs after a restart", async () => {
    const orphan = await cache.reserve(policy);
    await writeFile(orphan.filePath("video.mp4"), Buffer.alloc(40));
    const completed = await cache.reserve(policy);
    const artifact = await ready(completed);
    await completed.release({ retain: true });
    cache = createCache();
    await cache.sweep();
    await expect(lstat(orphan.filePath("video.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cache.inspect(completed.id)).toEqual(artifact);
    now += 101;
    cache = createCache();
    await cache.sweep();
    expect(await cache.inspect(completed.id)).toBeNull();
  });

  it("uses separate expiration times for each artifact and private cache directories", async () => {
    const first = await cache.reserve(policy);
    await ready(first, 20, 100);
    await first.release({ retain: true });
    now += 50;
    const second = await cache.reserve(policy);
    const artifact = await ready(second, 20, 200);
    await second.release({ retain: true });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(dirname(artifact.path))).mode & 0o777).toBe(0o700);
    now = 1100;
    await cache.sweep();
    expect(await cache.inspect(first.id)).toBeNull();
    expect(await cache.inspect(second.id)).toEqual(artifact);
  });

  it("serializes simultaneous reservations against total capacity", async () => {
    const requests = await Promise.allSettled([
      cache.reserve({ ...policy, maxCacheBytes: 150 }),
      cache.reserve({ ...policy, maxCacheBytes: 150 }),
    ]);
    expect(requests.filter((request) => request.status === "fulfilled")).toHaveLength(1);
    const failed = requests.find((request) => request.status === "rejected");
    expect(failed).toMatchObject({ status: "rejected", reason: { code: "cache_capacity" } });
  });

  it("counts retained bytes and releases unused reservation space after commit", async () => {
    const first = await cache.reserve({ ...policy, maxCacheBytes: 120 });
    await ready(first, 20);
    await first.release({ retain: true });
    const second = await cache.reserve({ ...policy, maxCacheBytes: 120 });
    await expect(cache.reserve({ ...policy, maxCacheBytes: 120 })).rejects.toMatchObject({
      code: "cache_capacity",
    });
    await second.release();
    await cache.remove(first.id);
    await expect(cache.reserve({ ...policy, maxCacheBytes: 100 })).resolves.toBeDefined();
  });

  it("deletes failed or cancelled work immediately and permits idempotent release", async () => {
    const lease = await cache.reserve(policy);
    await writeFile(lease.filePath("video.mp4"), Buffer.alloc(10));
    await lease.release();
    await lease.release();
    await expect(lstat(dirname(lease.filePath("video.mp4")))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lease.checkSpace()).rejects.toMatchObject({ code: "cache_lease_closed" });
    await expect(cache.reserve({ ...policy, maxCacheBytes: 100 })).resolves.toBeDefined();
  });

  it("protects an active lease during sweep, including expired artifacts being sent", async () => {
    const lease = await cache.reserve(policy);
    const artifact = await ready(lease);
    now += 200;
    await cache.sweep();
    expect((await lstat(artifact.path)).size).toBe(20);
    await expect(cache.remove(lease.id)).rejects.toMatchObject({ code: "cache_lease_active" });
    await lease.release({ retain: true });
    await expect(lstat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects insufficient disk space before creating a task", async () => {
    free = 149;
    await expect(cache.reserve(policy)).rejects.toMatchObject({ code: "insufficient_disk_space" });
    expect(await readdir(root)).toEqual([".video-download-cache.json"]);
    free = 150;
    await expect(cache.reserve(policy)).resolves.toBeDefined();
  });

  it("accounts for outstanding reservations when actual disk free space is checked", async () => {
    free = 250;
    const first = await cache.reserve(policy);
    const second = await cache.reserve(policy);
    await writeFile(first.filePath("video.mp4"), Buffer.alloc(40));
    free = 210;
    await first.checkSpace();
    free = 209;
    await expect(second.checkSpace()).rejects.toMatchObject({ code: "insufficient_disk_space" });
    await first.release();
    free = 150;
    await second.checkSpace();
  });

  it("rejects files exceeding a lease reservation or final upload limit", async () => {
    const lease = await cache.reserve(policy);
    await writeFile(lease.filePath("output.mp4"), Buffer.alloc(101));
    await expect(lease.checkSpace()).rejects.toMatchObject({ code: "file_too_large" });
    await expect(
      lease.commit("output.mp4", { ttlMs: 100, maxFileBytes: 100 }),
    ).rejects.toMatchObject({
      code: "file_too_large",
    });
    await writeFile(lease.filePath("output.mp4"), Buffer.alloc(80));
    await expect(
      lease.commit("output.mp4", { ttlMs: 100, maxFileBytes: 50 }),
    ).rejects.toMatchObject({
      code: "file_too_large",
    });
    await lease.release();
  });

  it("rejects symbolic links at the root and preserves the external target", async () => {
    const external = join(temporary, "external");
    await writeFile(external, "private");
    await symlink(temporary, root);
    await expect(cache.reserve(policy)).rejects.toMatchObject({ code: "invalid_cache_path" });
    expect(await readFile(external, "utf8")).toBe("private");
  });

  it("rejects symlink artifacts and symlink metadata without touching their targets", async () => {
    const external = join(temporary, "external");
    await writeFile(external, "private");
    const lease = await cache.reserve(policy);
    await symlink(external, lease.filePath("output.mp4"));
    await expect(
      lease.commit("output.mp4", { ttlMs: 100, maxFileBytes: 100 }),
    ).rejects.toMatchObject({
      code: "cache_invalid_file",
    });
    await lease.release();
    const another = await cache.reserve(policy);
    const metadata = join(dirname(another.filePath("output.mp4")), "metadata.json");
    await rm(metadata);
    await symlink(external, metadata);
    await writeFile(another.filePath("output.mp4"), "video");
    await expect(
      another.commit("output.mp4", { ttlMs: 100, maxFileBytes: 100 }),
    ).rejects.toMatchObject({
      code: "cache_invalid_file",
    });
    await another.release();
    expect(await readFile(external, "utf8")).toBe("private");
  });

  it("removes persisted symlink jobs without following the link", async () => {
    await cache.sweep();
    const external = join(temporary, "external");
    await writeFile(external, "private");
    const id = randomUUID();
    await symlink(temporary, join(root, id));
    await cache.sweep();
    await expect(lstat(join(root, id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(external, "utf8")).toBe("private");
  });

  it("refuses existing non-cache data and invalid task IDs", async () => {
    root = temporary;
    cache = createCache();
    await writeFile(join(root, "unrelated"), "keep");
    await expect(cache.reserve(policy)).rejects.toMatchObject({ code: "invalid_cache_path" });
    expect(await readFile(join(root, "unrelated"), "utf8")).toBe("keep");
    root = join(temporary, "dedicated");
    cache = createCache();
    await expect(cache.reserve({ ...policy, id: "../escape" })).rejects.toMatchObject({
      code: "invalid_cache_path",
    });
    await expect(cache.remove("../escape")).rejects.toMatchObject({ code: "invalid_cache_path" });
  });

  it("cleans malformed metadata and tampered completed files on sweep", async () => {
    const lease = await cache.reserve(policy);
    await ready(lease);
    await lease.release({ retain: true });
    await writeFile(lease.filePath("output.mp4"), "tampered");
    await cache.sweep();
    expect(await cache.inspect(lease.id)).toBeNull();
    const malformed = await cache.reserve(policy);
    await writeFile(join(dirname(malformed.filePath("output.mp4")), "metadata.json"), "invalid");
    cache = createCache();
    await cache.sweep();
    expect(await cache.inspect(malformed.id)).toBeNull();
  });

  it("schedules bounded periodic sweeps and stops cleanly", async () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(cache, "sweep").mockResolvedValue();
    const onError = vi.fn();
    cache.startSweep(20, onError);
    await vi.advanceTimersByTimeAsync(60);
    expect(sweep).toHaveBeenCalledTimes(3);
    cache.stopSweep();
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps an orphan when its pre-removal worker cancellation fails and deletes it after retry", async () => {
    const orphan = await cache.reserve(policy);
    await writeFile(orphan.filePath("video.mp4"), "unfinished video");
    const beforeRemove = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("worker still running"));
    cache = new VideoDownloadCache({
      root,
      now: () => now,
      statfs: async () => ({ bavail: BigInt(free), bsize: 1n }),
      beforeRemove,
    });
    await expect(cache.sweep()).rejects.toThrow("worker still running");
    expect(beforeRemove).toHaveBeenCalledWith(orphan.id);
    expect(await readFile(orphan.filePath("video.mp4"), "utf8")).toBe("unfinished video");
    await cache.sweep();
    expect(beforeRemove).toHaveBeenCalledTimes(2);
    await expect(lstat(orphan.filePath("video.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
