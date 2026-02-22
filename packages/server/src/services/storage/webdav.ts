import { readFile } from "node:fs/promises";
import type { StorageProvider } from "./types.js";

export class WebDAVProvider implements StorageProvider {
  private baseUrl: string;
  private authHeader: string;

  constructor(url: string, username: string, password: string) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  async upload(localPath: string, remoteName: string): Promise<string> {
    const data = await readFile(localPath);
    const remoteUrl = `${this.baseUrl}/${remoteName}`;

    const res = await fetch(remoteUrl, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
      },
      body: data,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`WebDAV upload failed (${res.status}): ${text}`);
    }

    return remoteUrl;
  }

  async delete(remoteName: string): Promise<void> {
    const remoteUrl = `${this.baseUrl}/${remoteName}`;
    const res = await fetch(remoteUrl, {
      method: "DELETE",
      headers: { Authorization: this.authHeader },
    });
    // 404 is fine — already deleted
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`WebDAV delete failed (${res.status}): ${text}`);
    }
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(this.baseUrl, {
        method: "PROPFIND",
        headers: {
          Authorization: this.authHeader,
          Depth: "0",
        },
      });
      if (res.ok || res.status === 207) {
        return { ok: true };
      }
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
