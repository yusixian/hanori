import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import type { RssCollectionRecord } from "@cos-tool-bot/shared";
import { Loader2 } from "lucide-react";
import { useState } from "react";

const DIGEST_PROMPT_PLACEHOLDER = `Leave empty for default. Example:
1. Summarize each item with key bullet points
2. Include original links
3. Use multi_message to send in segments
4. Save to rss/{{slug}}/{{date}}.md`;

export function CollectionForm({
  botId,
  collection,
  onSaved,
  onCancel,
}: {
  botId: string;
  collection?: RssCollectionRecord;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEdit = !!collection;
  const [name, setName] = useState(collection?.name ?? "");
  const [chatId, setChatId] = useState(collection ? String(collection.chatId) : "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [digestPrompt, setDigestPrompt] = useState(collection?.digestPrompt ?? "");
  const [digestTime, setDigestTime] = useState(
    collection
      ? `${String(collection.digestHour).padStart(2, "0")}:${String(collection.digestMinute).padStart(2, "0")}`
      : "09:00",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !chatId) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name,
        chatId: Number(chatId),
        description: description || undefined,
        digestPrompt: digestPrompt || undefined,
        digestHour: Number(digestTime.split(":")[0]),
        digestMinute: Number(digestTime.split(":")[1]),
      };
      const res = isEdit
        ? await client.api.bots[":botId"].rss.collections[":id"].$patch({
            param: { botId, id: String(collection.id) },
            json: payload,
          })
        : await client.api.bots[":botId"].rss.collections.$post({
            param: { botId },
            json: payload,
          });
      if (!res.ok) {
        setError(`Failed to ${isEdit ? "update" : "create"} collection (${res.status})`);
        return;
      }
      onSaved();
    } catch {
      setError("Network error, please try again");
    } finally {
      setSubmitting(false);
    }
  };

  const form = (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          placeholder="Collection name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          type="number"
          placeholder="Chat ID (target)"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          required
        />
      </div>
      <Input
        placeholder="Description (optional, shown in collection header)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="space-y-1">
        <label className="text-muted-foreground text-xs">
          Digest Prompt (optional, variables: {"{{name}}"} {"{{slug}}"} {"{{date}}"})
        </label>
        <textarea
          className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={DIGEST_PROMPT_PLACEHOLDER}
          value={digestPrompt}
          onChange={(e) => setDigestPrompt(e.target.value)}
          rows={5}
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm">Digest Time (UTC):</label>
        <Input
          type="time"
          className="w-28"
          value={digestTime}
          onChange={(e) => setDigestTime(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isEdit ? "Save" : "Create"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );

  if (isEdit) return form;

  return (
    <Card>
      <CardContent className="pt-6">{form}</CardContent>
    </Card>
  );
}
