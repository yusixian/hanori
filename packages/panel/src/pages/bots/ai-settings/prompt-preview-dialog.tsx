import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { AiConfigPublic } from "@cos-tool-bot/shared";
import { DEFAULT_BOT_MEMORY_CONFIG, DEFAULT_MEMORY_CONFIG } from "@cos-tool-bot/shared";
import { ClipboardCopy, Eye, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface PromptPreviewDialogProps {
  botId: string;
  config: AiConfigPublic;
  stickerPacks: string[];
  open: boolean;
  onClose: () => void;
}

const PLACEHOLDER_PATTERNS = [
  "[Environment: injected at runtime — username, chat type, and more]",
  "[Current user profile: injected at runtime]",
  "[Current mood: injected at runtime]",
  "[Long-term memory: injected at runtime]",
  "[Conversation history: injected at runtime]",
  "--- Dynamic content below (changes for every request) ---",
];

function highlightDynamic(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    let earliestIndex = -1;
    let matchedPattern = "";

    for (const pattern of PLACEHOLDER_PATTERNS) {
      const idx = remaining.indexOf(pattern);
      if (idx !== -1 && (earliestIndex === -1 || idx < earliestIndex)) {
        earliestIndex = idx;
        matchedPattern = pattern;
      }
    }

    if (earliestIndex === -1) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }

    if (earliestIndex > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, earliestIndex)}</span>);
    }

    parts.push(
      <span
        key={key++}
        className="rounded border border-dashed border-amber-500/40 bg-amber-500/10 px-1 text-amber-300"
      >
        {matchedPattern}
      </span>,
    );

    remaining = remaining.slice(earliestIndex + matchedPattern.length);
  }

  return parts;
}

export function PromptPreviewDialog({
  botId,
  config,
  stickerPacks,
  open,
  onClose,
}: PromptPreviewDialogProps) {
  const [isPrivate, setIsPrivate] = useState(true);
  const [loading, setLoading] = useState(false);
  const [fullPrompt, setFullPrompt] = useState("");
  const [estimatedTokens, setEstimatedTokens] = useState(0);
  const [copied, setCopied] = useState(false);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    try {
      const memCfg = config.memoryConfig ?? DEFAULT_MEMORY_CONFIG;
      const botMemCfg = config.botMemoryConfig ?? DEFAULT_BOT_MEMORY_CONFIG;

      const res = await client.api.bots[":botId"]["ai-config"]["prompt-preview"].$post({
        param: { botId },
        json: {
          isPrivate,
          systemPrompt: config.systemPrompt,
          behavioralPrompt: config.behavioralPrompt,
          groupBehavioralPrompt: config.groupBehavioralPrompt,
          memoryEnabled: memCfg.enabled,
          botMemoryEnabled: botMemCfg.enabled,
          stickerPacks,
          webToolsConfig: config.webToolsConfig,
          agentToolsConfig: config.agentToolsConfig,
          artworkToolsEnabled: config.artworkToolsConfig?.enabled,
          messageConfig: config.messageConfig,
        },
      });
      const json = await res.json();
      if (json.ok) {
        setFullPrompt(json.data.fullPrompt);
        setEstimatedTokens(json.data.estimatedTokens);
      } else {
        setFullPrompt(`Error: ${"error" in json ? String(json.error) : "Failed to load preview"}`);
        setEstimatedTokens(0);
      }
    } catch (err) {
      console.error("Failed to fetch prompt preview:", err);
      setFullPrompt("Failed to load preview");
      setEstimatedTokens(0);
    } finally {
      setLoading(false);
    }
  }, [botId, config, stickerPacks, isPrivate]);

  useEffect(() => {
    if (open) {
      fetchPreview();
    }
  }, [open, fetchPreview]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: ignore clipboard errors in non-secure contexts
    }
  };

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close prompt preview"
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-preview-title"
        className="bg-card relative mx-4 flex max-h-[90vh] w-full max-w-4xl flex-col overscroll-contain rounded-lg shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-3">
            <Eye className="h-5 w-5 text-purple-500" />
            <h2 id="prompt-preview-title" className="text-lg font-semibold">
              Prompt Preview
            </h2>
          </div>
          <button
            type="button"
            className="hover:bg-accent focus-visible:ring-ring rounded p-1 focus-visible:ring-2"
            onClick={onClose}
            aria-label="Close prompt preview"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 border-b px-5 py-3">
          <span className="text-sm font-medium">Chat type:</span>
          <div className="bg-muted flex gap-1 rounded-md p-0.5">
            <button
              type="button"
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                isPrivate
                  ? "bg-card font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setIsPrivate(true)}
              aria-pressed={isPrivate}
            >
              Private
            </button>
            <button
              type="button"
              className={cn(
                "rounded-md px-3 py-1 text-sm transition-colors",
                !isPrivate
                  ? "bg-card font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setIsPrivate(false)}
              aria-pressed={!isPrivate}
            >
              Group
            </button>
          </div>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <ClipboardCopy className="h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <CodeBlock className="max-h-none text-sm leading-relaxed">
              {highlightDynamic(fullPrompt)}
            </CodeBlock>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-5 py-3">
          <div className="text-muted-foreground flex gap-4 text-xs">
            <span>{fullPrompt.length.toLocaleString()} chars</span>
            <span>~{estimatedTokens.toLocaleString()} tokens (est.)</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded border border-dashed border-amber-400/60 bg-amber-500/10"
              title="Dynamic placeholder"
            />
            <span className="text-muted-foreground text-xs">= runtime dynamic content</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
