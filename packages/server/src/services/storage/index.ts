import type { BackupStorageConfig } from "@cos-tool-bot/shared";
import type { StorageProvider } from "./types.js";

export type { StorageProvider } from "./types.js";

export async function createStorageProvider(
  config: BackupStorageConfig,
  decryptFn: (encrypted: string) => string,
): Promise<StorageProvider | null> {
  switch (config.type) {
    case "local":
      return null;
    case "webdav": {
      const { WebDAVProvider } = await import("./webdav.js");
      const password = decryptFn(config.encryptedPassword);
      return new WebDAVProvider(config.url, config.username, password);
    }
    case "s3": {
      const { S3Provider } = await import("./s3.js");
      const secretAccessKey = decryptFn(config.encryptedSecretKey);
      return new S3Provider({
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpoint,
        accessKeyId: config.accessKeyId,
        secretAccessKey,
        prefix: config.prefix,
      });
    }
  }
}
