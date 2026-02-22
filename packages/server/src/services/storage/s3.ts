import {
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
  type StorageClass,
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { StorageProvider } from "./types.js";

interface S3ProviderOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  forcePathStyle?: boolean;
  storageClass?: string;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
}

export class S3Provider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private storageClass?: string;
  private serverSideEncryption?: string;
  private sseKmsKeyId?: string;

  constructor(options: S3ProviderOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ? options.prefix.replace(/\/+$/, "") + "/" : "";
    this.storageClass = options.storageClass;
    this.serverSideEncryption = options.serverSideEncryption;
    this.sseKmsKeyId = options.sseKmsKeyId;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint || undefined,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: options.forcePathStyle ?? false,
    });
  }

  async upload(localPath: string, remoteName: string): Promise<string> {
    const fileStats = await stat(localPath);
    const key = this.prefix + remoteName;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentLength: fileStats.size,
        ContentType: "application/gzip",
        ...(this.storageClass && { StorageClass: this.storageClass as StorageClass }),
        ...(this.serverSideEncryption && {
          ServerSideEncryption: this.serverSideEncryption as ServerSideEncryption,
        }),
        ...(this.sseKmsKeyId && { SSEKMSKeyId: this.sseKmsKeyId }),
      }),
    );

    return `s3://${this.bucket}/${key}`;
  }

  async delete(remoteName: string): Promise<void> {
    const key = this.prefix + remoteName;
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
