import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface EmbeddingFormConfig {
  enabled: boolean;
  hasApiKey: boolean;
  baseURL: string;
  model: string;
  dimensions: number;
  apiKey: string;
}

export function EmbeddingSection({
  config,
  onUpdate,
}: {
  config: EmbeddingFormConfig;
  onUpdate: (updates: Partial<EmbeddingFormConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Embedding (Semantic Search)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="embeddingEnabled"
            checked={config.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            className="border-input h-4 w-4 rounded"
          />
          <label htmlFor="embeddingEnabled" className="text-sm font-medium">
            Enable Embedding
          </label>
        </div>
        <p className="text-muted-foreground text-xs">
          Enables semantic vector search for memories and conversation history. Requires a separate
          embedding API (e.g. OpenAI text-embedding-3-small). When disabled, search falls back to
          keyword matching.
        </p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">API Base URL</label>
          <Input
            disabled={!config.enabled}
            value={config.baseURL}
            onChange={(e) => onUpdate({ baseURL: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">
            API Key {config.hasApiKey && "(configured)"}
          </label>
          <Input
            type="password"
            disabled={!config.enabled}
            value={config.apiKey}
            onChange={(e) => onUpdate({ apiKey: e.target.value })}
            placeholder={config.hasApiKey ? "Leave empty to keep current key" : "sk-..."}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Model</label>
          <Input
            disabled={!config.enabled}
            value={config.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            placeholder="text-embedding-3-small"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Dimensions</label>
          <Input type="number" disabled value={config.dimensions} readOnly />
          <p className="text-muted-foreground text-xs">
            System-level setting controlled by the <code>EMBEDDING_DIMENSIONS</code> environment
            variable (default 3072). Changing requires redeployment and migration regeneration.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
