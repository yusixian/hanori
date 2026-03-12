import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { TimeoutConfig } from "@cos-tool-bot/shared";
import { DEFAULT_TIMEOUT_CONFIG } from "@cos-tool-bot/shared";

interface TimeoutField {
  key: keyof TimeoutConfig;
  label: string;
  description: string;
  min: number;
}

const TIMEOUT_FIELDS: TimeoutField[] = [
  {
    key: "aiReplyMs",
    label: "AI Reply Timeout",
    description: "Main AI generateText total timeout.",
    min: 1,
  },
  {
    key: "perStepMs",
    label: "Per-Step Timeout",
    description: "Timeout for each individual AI model call within a multi-step request.",
    min: 1,
  },
  {
    key: "searchMs",
    label: "Search Timeout",
    description: "Web search request timeout.",
    min: 1,
  },
  {
    key: "fetchPageMs",
    label: "Fetch Page Timeout",
    description: "Web page / API fetch timeout.",
    min: 1,
  },
  {
    key: "imageGenerationMs",
    label: "Image Generation Timeout",
    description: "AI image generation request timeout.",
    min: 1,
  },
  {
    key: "researcherAgentMs",
    label: "Researcher Agent Timeout",
    description: "Sub-agent timeout for researcher tasks.",
    min: 1,
  },
  {
    key: "defaultAgentMs",
    label: "Default Agent Timeout",
    description: "Sub-agent timeout for other tasks.",
    min: 1,
  },
  {
    key: "imageDownloadMs",
    label: "Image Download Timeout",
    description: "Image/file download timeout.",
    min: 1,
  },
  {
    key: "pixaiTaskMs",
    label: "PixAI Task Timeout",
    description: "PixAI background task polling timeout.",
    min: 1,
  },
];

export function TimeoutSection({
  config,
  onUpdate,
}: {
  config: TimeoutConfig;
  onUpdate: (updates: Partial<TimeoutConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timeout Configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          Configure timeout values for various operations (in seconds). Leave empty to use defaults.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TIMEOUT_FIELDS.map((field) => {
            const valueMs = config[field.key];
            const defaultMs = DEFAULT_TIMEOUT_CONFIG[field.key];
            const valueSec = valueMs != null ? String(valueMs / 1000) : "";
            return (
              <div key={field.key} className="space-y-1.5">
                <label className="text-sm font-medium">{field.label}</label>
                <Input
                  type="number"
                  min={field.min}
                  placeholder={String(defaultMs / 1000)}
                  value={valueSec}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      onUpdate({ [field.key]: undefined });
                    } else {
                      onUpdate({ [field.key]: Number(raw) * 1000 });
                    }
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  {field.description} Default: {defaultMs / 1000}s
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
