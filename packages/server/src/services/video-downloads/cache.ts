import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const FILES = ["video.mp4", "audio.m4a", "output.mp4"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER = ".video-download-cache.json";
const METADATA = "metadata.json";

export type VideoDownloadFile = (typeof FILES)[number];
export type VideoDownloadCacheErrorCode =
  | "invalid_cache_path"
  | "cache_capacity"
  | "insufficient_disk_space"
  | "file_too_large"
  | "cache_invalid_file"
  | "cache_lease_closed"
  | "cache_lease_active";

export class VideoDownloadCacheError extends Error {
  constructor(
    public readonly code: VideoDownloadCacheErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VideoDownloadCacheError";
  }
}

export interface VideoDownloadCacheOptions {
  root: string;
  now?: () => number;
  statfs?: (root: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  /** Confirm no separate media worker still uses orphaned files before deleting them. */
  beforeRemove?: (id: string) => Promise<void>;
}

export interface VideoDownloadReservation {
  id?: string;
  reservedBytes: number;
  maxCacheBytes: number;
  minFreeDiskBytes: number;
}

export interface CachedVideoDownload {
  id: string;
  path: string;
  bytes: number;
  expiresAt: number;
}

interface ReadyMetadata {
  version: 1;
  state: "ready";
  file: VideoDownloadFile;
  bytes: number;
  expiresAt: number;
}

interface ActiveReservation {
  reservedBytes: number;
  minFreeDiskBytes: number;
  ready?: ReadyMetadata;
}

function validBytes(value: number, positive = false): boolean {
  return Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function fail(code: VideoDownloadCacheErrorCode, message: string): never {
  throw new VideoDownloadCacheError(code, message);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** One cache instance per root in a single server process. No cross-process locking is provided. */
export class VideoDownloadCache {
  private root: string;
  private readonly now: () => number;
  private readonly disk: NonNullable<VideoDownloadCacheOptions["statfs"]>;
  private readonly beforeRemove: VideoDownloadCacheOptions["beforeRemove"];
  private initialized = false;
  private readonly active = new Map<string, ActiveReservation>();
  private readonly retained = new Map<string, ReadyMetadata>();
  private queue: Promise<unknown> = Promise.resolve();
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private sweepGeneration = 0;

  constructor(options: VideoDownloadCacheOptions) {
    this.root = resolve(options.root);
    if ([resolve("/"), resolve(homedir()), resolve(process.cwd())].includes(this.root)) {
      fail("invalid_cache_path", "Video cache requires a dedicated directory");
    }
    this.now = options.now ?? Date.now;
    this.disk = options.statfs ?? ((path) => statfs(path, { bigint: true }));
    this.beforeRemove = options.beforeRemove;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private directory(id: string): string {
    if (!UUID.test(id)) fail("invalid_cache_path", "Cache task ID must be a UUID");
    return join(this.root, id);
  }

  private async assertDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail("invalid_cache_path", "Cache directories must not be symbolic links");
    }
  }

  private async readJson(path: string): Promise<unknown> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
      fail("cache_invalid_file", "Invalid cache metadata file");
    }
    return JSON.parse(await readFile(path, "utf8"));
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      await this.assertDirectory(this.root);
      return;
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.assertDirectory(this.root);
    // Canonicalize parent aliases (e.g. macOS /tmp), while rejecting a symlink at the cache root.
    this.root = join(await realpath(dirname(this.root)), this.root.split(/[\\/]/).at(-1)!);
    const entries = await readdir(this.root);
    if (entries.includes(MARKER)) {
      const marker = await this.readJson(join(this.root, MARKER));
      if (
        !marker ||
        typeof marker !== "object" ||
        !("kind" in marker) ||
        marker.kind !== "video-download-cache-v1"
      ) {
        fail("invalid_cache_path", "Directory is not a video download cache");
      }
    } else {
      if (entries.length) fail("invalid_cache_path", "Cache directory must be empty on first use");
      await writeFile(join(this.root, MARKER), '{"kind":"video-download-cache-v1"}', {
        flag: "wx",
        mode: 0o600,
      });
    }
    await chmod(this.root, 0o700);
    this.initialized = true;
    await this.sweepUnlocked();
  }

  private async fileSizes(id: string): Promise<Map<VideoDownloadFile, number>> {
    const directory = this.directory(id);
    await this.assertDirectory(directory);
    const sizes = new Map<VideoDownloadFile, number>();
    for (const name of await readdir(directory)) {
      if (name !== METADATA && !FILES.includes(name as VideoDownloadFile)) {
        fail("cache_invalid_file", "Unexpected file in video cache task");
      }
      const info = await lstat(join(directory, name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        fail("cache_invalid_file", "Cached video must be a regular private file");
      }
      if (name === METADATA) continue;
      if (!validBytes(info.size)) fail("file_too_large", "Cached video size is out of range");
      sizes.set(name as VideoDownloadFile, info.size);
    }
    return sizes;
  }

  private async sweepUnlocked(): Promise<void> {
    await this.assertDirectory(this.root);
    for (const id of await readdir(this.root)) {
      if (id === MARKER) continue;
      if (!UUID.test(id)) fail("invalid_cache_path", "Unexpected entry in video cache root");
      if (this.active.has(id)) continue;
      let ready: ReadyMetadata | undefined;
      try {
        await this.assertDirectory(this.directory(id));
        const value = await this.readJson(join(this.directory(id), METADATA));
        if (value && typeof value === "object") {
          const candidate = value as Partial<ReadyMetadata>;
          if (
            candidate.version === 1 &&
            candidate.state === "ready" &&
            FILES.includes(candidate.file as VideoDownloadFile) &&
            validBytes(candidate.bytes ?? -1, true) &&
            Number.isSafeInteger(candidate.expiresAt) &&
            candidate.expiresAt! > this.now()
          ) {
            const sizes = await this.fileSizes(id);
            if (sizes.size === 1 && sizes.get(candidate.file!) === candidate.bytes) {
              ready = candidate as ReadyMetadata;
            }
          }
        }
      } catch (error) {
        if (
          !(error instanceof VideoDownloadCacheError) &&
          !isMissing(error) &&
          !(error instanceof SyntaxError)
        ) {
          throw error;
        }
      }
      if (ready) this.retained.set(id, ready);
      else {
        // rm unlinks symlinks; it never follows them to external files.
        await this.beforeRemove?.(id);
        await rm(this.directory(id), { recursive: true, force: true });
        this.retained.delete(id);
      }
    }
    for (const id of this.retained.keys()) {
      try {
        await lstat(this.directory(id));
      } catch (error) {
        if (!isMissing(error)) throw error;
        this.retained.delete(id);
      }
    }
  }

  async sweep(): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      await this.sweepUnlocked();
    });
  }

  startSweep(intervalMs: number, onError: (error: unknown) => void): void {
    if (!validBytes(intervalMs, true) || intervalMs > 2_147_483_647) {
      throw new RangeError("Sweep interval is outside the Node timer range");
    }
    this.stopSweep();
    const generation = this.sweepGeneration;
    const schedule = () => {
      this.sweepTimer = setTimeout(async () => {
        try {
          await this.sweep();
        } catch (error) {
          onError(error);
        } finally {
          if (generation === this.sweepGeneration) schedule();
        }
      }, intervalMs);
      this.sweepTimer.unref();
    };
    schedule();
  }

  stopSweep(): void {
    this.sweepGeneration++;
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async checkDisk(extraBytes = 0, extraFloor = 0): Promise<void> {
    let remaining = extraBytes;
    let floor = extraFloor;
    for (const [id, reservation] of this.active) {
      const sizes = await this.fileSizes(id);
      const used = [...sizes.values()].reduce((sum, size) => sum + size, 0);
      if (used > reservation.reservedBytes) {
        fail("file_too_large", "Video download exceeded its reserved disk space");
      }
      remaining += reservation.reservedBytes - used;
      floor = Math.max(floor, reservation.minFreeDiskBytes);
    }
    const disk = await this.disk(this.root);
    const available = BigInt(disk.bavail) * BigInt(disk.bsize);
    if (available < BigInt(remaining) + BigInt(floor)) {
      fail("insufficient_disk_space", "Not enough free disk space for video download");
    }
  }

  async reserve(options: VideoDownloadReservation): Promise<VideoDownloadLease> {
    if (
      !validBytes(options.reservedBytes, true) ||
      !validBytes(options.maxCacheBytes, true) ||
      !validBytes(options.minFreeDiskBytes)
    ) {
      throw new RangeError("Cache sizes must be safe integer byte counts");
    }
    return this.serial(async () => {
      await this.initialize();
      await this.sweepUnlocked();
      const id = options.id ?? randomUUID();
      const directory = this.directory(id);
      if (this.active.has(id) || this.retained.has(id)) {
        fail("invalid_cache_path", "Cache task ID already exists");
      }
      const occupied =
        [...this.retained.values()].reduce((sum, item) => sum + item.bytes, 0) +
        [...this.active.values()].reduce((sum, item) => sum + item.reservedBytes, 0);
      if (occupied + options.reservedBytes > options.maxCacheBytes) {
        fail("cache_capacity", "Video cache capacity is exhausted");
      }
      await this.checkDisk(options.reservedBytes, options.minFreeDiskBytes);
      await mkdir(directory, { mode: 0o700 });
      try {
        await writeFile(join(directory, METADATA), '{"version":1,"state":"pending"}', {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      this.active.set(id, {
        reservedBytes: options.reservedBytes,
        minFreeDiskBytes: options.minFreeDiskBytes,
      });
      return new VideoDownloadLease(this, id, directory);
    });
  }

  async checkSpace(id: string): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      if (!this.active.has(id)) fail("cache_lease_closed", "Video cache lease is closed");
      await this.checkDisk();
    });
  }

  async commit(
    id: string,
    file: VideoDownloadFile,
    options: { ttlMs: number; maxFileBytes: number },
  ): Promise<CachedVideoDownload> {
    if (!validBytes(options.ttlMs, true) || !validBytes(options.maxFileBytes, true)) {
      throw new RangeError("Video cache TTL and file limit must be positive safe integers");
    }
    return this.serial(async () => {
      await this.initialize();
      const reservation = this.active.get(id);
      if (!reservation || reservation.ready)
        fail("cache_lease_closed", "Video cache lease is closed");
      const sizes = await this.fileSizes(id);
      const bytes = sizes.get(file);
      if (!bytes) fail("cache_invalid_file", "Downloaded video is missing or empty");
      if (bytes > options.maxFileBytes)
        fail("file_too_large", "Downloaded video exceeds file size limit");
      await this.checkDisk();
      const expiresAt = this.now() + options.ttlMs;
      if (!Number.isSafeInteger(expiresAt))
        throw new RangeError("Video cache expiration is out of range");
      for (const input of sizes.keys()) {
        if (input !== file) await rm(join(this.directory(id), input));
      }
      const ready: ReadyMetadata = { version: 1, state: "ready", file, bytes, expiresAt };
      await writeFile(join(this.directory(id), METADATA), JSON.stringify(ready), { mode: 0o600 });
      reservation.reservedBytes = bytes;
      reservation.ready = ready;
      return { id, path: join(this.directory(id), file), bytes, expiresAt };
    });
  }

  async release(id: string, options: { retain?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      const reservation = this.active.get(id);
      if (!reservation) return;
      if (options.retain && reservation.ready && reservation.ready.expiresAt > this.now()) {
        this.retained.set(id, reservation.ready);
      } else {
        await rm(this.directory(id), { recursive: true, force: true });
      }
      this.active.delete(id);
    });
  }

  async inspect(id: string): Promise<CachedVideoDownload | null> {
    return this.serial(async () => {
      this.directory(id);
      await this.initialize();
      await this.sweepUnlocked();
      const ready = this.active.get(id)?.ready ?? this.retained.get(id);
      if (ready && (await this.fileSizes(id)).get(ready.file) !== ready.bytes) {
        fail("cache_invalid_file", "Cached video no longer matches its metadata");
      }
      return ready
        ? {
            id,
            path: join(this.directory(id), ready.file),
            bytes: ready.bytes,
            expiresAt: ready.expiresAt,
          }
        : null;
    });
  }

  async remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.directory(id);
      await this.initialize();
      if (this.active.has(id))
        fail("cache_lease_active", "Cannot remove an active video cache lease");
      await rm(this.directory(id), { recursive: true, force: true });
      this.retained.delete(id);
    });
  }
}

export class VideoDownloadLease {
  constructor(
    private readonly cache: VideoDownloadCache,
    public readonly id: string,
    private readonly directory: string,
  ) {}

  filePath(file: VideoDownloadFile): string {
    if (!FILES.includes(file)) fail("cache_invalid_file", "Unsupported video cache file name");
    return join(this.directory, file);
  }

  checkSpace(): Promise<void> {
    return this.cache.checkSpace(this.id);
  }

  commit(
    file: VideoDownloadFile,
    options: { ttlMs: number; maxFileBytes: number },
  ): Promise<CachedVideoDownload> {
    return this.cache.commit(this.id, file, options);
  }

  release(options: { retain?: boolean } = {}): Promise<void> {
    return this.cache.release(this.id, options);
  }
}
