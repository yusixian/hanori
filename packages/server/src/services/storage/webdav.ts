import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { StorageProvider } from "./types.js";

async function releaseResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export function webdavRecordUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

function webdavRequest(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init).catch(() => {
    throw new Error("WebDAV request failed");
  });
}

export class WebDAVProvider implements StorageProvider {
  private baseUrl: string;
  private authHeader: string;

  constructor(url: string, username: string, password: string) {
    const baseUrl = new URL(url);
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
    this.baseUrl = baseUrl.href;
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  private remoteUrl(remoteName: string): string {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(remoteName)}`;
    return url.href;
  }

  async upload(localPath: string, remoteName: string): Promise<string> {
    const fileStats = await stat(localPath);
    const nodeStream = createReadStream(localPath);
    try {
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;
      const remoteUrl = this.remoteUrl(remoteName);
      const res = await webdavRequest(remoteUrl, {
        method: "PUT",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(fileStats.size),
        },
        body: webStream,
        duplex: "half",
      } as RequestInit);
      try {
        if (!res.ok) {
          throw new Error(`WebDAV upload failed (${res.status})`);
        }
        return webdavRecordUrl(remoteUrl)!;
      } finally {
        await releaseResponse(res);
      }
    } finally {
      nodeStream.destroy();
    }
  }

  async delete(remoteName: string): Promise<void> {
    const remoteUrl = this.remoteUrl(remoteName);
    const res = await webdavRequest(remoteUrl, {
      method: "DELETE",
      headers: { Authorization: this.authHeader },
    });
    try {
      // 404 is fine — already deleted
      if (!res.ok && res.status !== 404) {
        throw new Error(`WebDAV delete failed (${res.status})`);
      }
    } finally {
      await releaseResponse(res);
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await webdavRequest(this.baseUrl, {
        method: "PROPFIND",
        headers: {
          Authorization: this.authHeader,
          Depth: "0",
        },
      });
      try {
        if (res.ok || res.status === 207) {
          return { ok: true };
        }
        return { ok: false, error: `HTTP ${res.status}` };
      } finally {
        await releaseResponse(res);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
