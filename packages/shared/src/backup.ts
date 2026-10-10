export type BackupStorageType = "local" | "webdav" | "s3";

export interface BackupConfigLocal {
  type: "local";
}
export interface BackupConfigWebDAV {
  type: "webdav";
  url: string;
  username: string;
  encryptedPassword: string;
}
export interface BackupConfigS3 {
  type: "s3";
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  encryptedSecretKey: string;
  prefix?: string;
  forcePathStyle?: boolean;
  storageClass?: string;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
}

export type BackupStorageConfig = BackupConfigLocal | BackupConfigWebDAV | BackupConfigS3;

export interface BackupRetentionConfig {
  maxCount?: number;
}

export interface BackupConfig {
  storage: BackupStorageConfig;
  filePrefix?: string;
  retention?: BackupRetentionConfig;
}

export type BackupStatus = "completed" | "failed";

export interface BackupResult {
  ok: boolean;
  filename?: string;
  error?: string;
}

export interface BackupRecord {
  id: number;
  filename: string;
  sizeBytes: number;
  durationMs: number;
  remoteUrl: string | null;
  remoteProvider: string | null;
  status: BackupStatus;
  error: string | null;
  createdAt: string;
}

/** Backup prefixes are filename components, never directory paths. */
export function isValidBackupFilePrefix(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "/" || char === "\\" || code < 32 || code === 127) return false;
  }
  return true;
}
