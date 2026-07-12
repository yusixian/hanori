import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";
import type { RssCollectionRecord } from "@cos-tool-bot/shared";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation("bots");
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
        setError(
          isEdit
            ? t("rss.updateFailed", { status: res.status })
            : t("rss.createFailed", { status: res.status }),
        );
        return;
      }
      onSaved();
    } catch {
      setError(t("rss.networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  const form = (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          placeholder={t("rss.collectionName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          type="number"
          placeholder={t("rss.targetChatId")}
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          required
        />
      </div>
      <Input
        placeholder={t("rss.descriptionPlaceholder")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="space-y-1">
        <label className="text-muted-foreground text-xs">
          {t("rss.digestPromptLabel", {
            name: "{{name}}",
            slug: "{{slug}}",
            date: "{{date}}",
          })}
        </label>
        <Textarea
          className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={t("rss.digestPromptPlaceholder", {
            slug: "{{slug}}",
            date: "{{date}}",
          })}
          value={digestPrompt}
          onChange={(e) => setDigestPrompt(e.target.value)}
          rows={5}
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm">{t("rss.digestTime")}</label>
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
          {isEdit ? t("common:common.save") : t("common:common.create")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t("common:common.cancel")}
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
