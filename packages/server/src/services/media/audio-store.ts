import { constants } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectConvertedWav } from "./wav.js";

const ttlSeconds = 60 * 60;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const filePattern = /^([a-f0-9-]{36})\.(\d{10})\.wav$/;

/** Only confirmed, validated audio can be staged. Signed URLs survive a host restart. */
export class MediaAudioStore {
  private readonly directory: string;
  private readonly origin: string | undefined;
  constructor(
    directory: string,
    baseUrl: string,
    private readonly secret: string,
  ) {
    this.directory = resolve(directory, "asr-audio");
    try {
      const url = new URL(baseUrl);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) &&
        !/\.(?:local|localhost|internal|test|invalid)$/.test(url.hostname)
      )
        this.origin = url.origin;
    } catch {
      /* Local deployments can still use direct-upload providers. */
    }
  }
  get available() {
    return this.origin !== undefined;
  }
  private signature(id: string, expires: string) {
    return createHmac("sha256", this.secret).update(`asr-audio:${id}:${expires}`).digest("hex");
  }
  private async root() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("invalid_audio_store");
  }
  async stage(id: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
    if (!uuid.test(id) || !this.origin) throw new Error("audio_url_unavailable");
    inspectConvertedWav(bytes, 655);
    signal?.throwIfAborted();
    await this.root();
    const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
    const path = join(this.directory, `${id}.${expires}.wav`);
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      signal?.throwIfAborted();
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
    const url = new URL(`/api/asr-audio/${id}`, this.origin);
    url.searchParams.set("expires", expires);
    url.searchParams.set("signature", this.signature(id, expires));
    return url.href;
  }
  async read(id: string, expires: string, signature: string): Promise<Buffer | null> {
    const now = Math.floor(Date.now() / 1000);
    if (
      !uuid.test(id) ||
      !/^\d{10}$/.test(expires) ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      Number(expires) <= now ||
      Number(expires) > now + ttlSeconds ||
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(this.signature(id, expires), "hex"),
      )
    )
      return null;
    let handle;
    try {
      await this.root();
      handle = await open(
        join(this.directory, `${id}.${expires}.wav`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 20 * 1024 * 1024 ||
        stat.size < 44
      )
        return null;
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size) return null;
      inspectConvertedWav(bytes, 655);
      return bytes;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
  async remove(id: string) {
    if (!uuid.test(id)) return;
    await this.root();
    for (const name of await readdir(this.directory)) {
      if (filePattern.test(name) && name.startsWith(`${id}.`))
        await unlink(join(this.directory, name));
    }
  }
  async sweep() {
    await this.root();
    const now = Math.floor(Date.now() / 1000);
    for (const name of await readdir(this.directory)) {
      const match = filePattern.exec(name);
      if (match && Number(match[2]) <= now) await unlink(join(this.directory, name));
    }
  }
}
