export interface DataFilesConfig {
  dataDir: string;
  snapshotFiles?: Readonly<Record<string, string>>;
  injectableFiles: ReadonlySet<string>;
  loadFiles: () => Promise<Array<{ name: string; content: string }>>;
}

/**
 * Inject data files (.md) content into the first system message.
 * Used by both ai-reply and continue-chat to append identity/soul/notes.
 */
export async function injectDataFiles(
  systemMessage: { content: string },
  dataFiles: DataFilesConfig,
): Promise<void> {
  try {
    const files = await dataFiles.loadFiles();
    for (const file of files) {
      systemMessage.content += `\n\n## ${file.name}\n${file.content}`;
    }
  } catch {
    // ignore data files load errors
  }
}
