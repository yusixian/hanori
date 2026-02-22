export interface StorageProvider {
  upload(localPath: string, remoteName: string): Promise<string>;
  delete(remoteName: string): Promise<void>;
  test(): Promise<{ ok: boolean; error?: string }>;
}
