export type McpTransport = "sse" | "streamable-http";

export interface McpServerRecord {
  id: number;
  name: string;
  description: string | null;
  transport: McpTransport;
  url: string;
  hasHeaders: boolean;
  presetId: string | null;
  isActive: boolean;
  toolNamePrefix: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface McpServerToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  serverId: number;
  connected: boolean;
  toolCount: number;
  tools: McpServerToolInfo[];
  lastConnectedAt: string | null;
  error: string | null;
}

export interface McpServerPreset {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  url: string;
  headerTemplate?: Record<string, string>;
  docsUrl?: string;
}
