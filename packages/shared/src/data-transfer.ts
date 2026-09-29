export interface ExportManifest {
  version: 1;
  exportedAt: string;
  scope: "bot" | "full";
  botId?: string;
  botName?: string;
  tables: string[];
  counts: Record<string, number>;
}

export interface ExportPayload {
  manifest: ExportManifest;
  settings?: Array<Record<string, unknown>>;
  bots: Array<Record<string, unknown>>;
  [tableName: string]: unknown;
}

export interface ImportResult {
  importedBots: Array<{ oldId: string; newId: string; name: string }>;
  counts: Record<string, number>;
}
