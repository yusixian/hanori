import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import type { SummaryAccessMode, SummaryConfigRecord } from "@cos-tool-bot/shared";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";

interface DefaultsData {
  systemPrompt: string;
  windowHours: number;
  maxMessages: number;
  cooldownSeconds: number;
  timezone: string;
}

export function SummaryConfigForm({
  botId,
  config,
  onSaved,
  onCancel,
}: {
  botId: string;
  config?: SummaryConfigRecord;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEdit = !!config;

  const [chatId, setChatId] = useState(config ? String(config.chatId) : "");
  const [isActive, setIsActive] = useState(config?.isActive ?? true);
  const [scheduleHour, setScheduleHour] = useState(
    config?.scheduleHour != null ? String(config.scheduleHour) : "",
  );
  const [scheduleMinute, setScheduleMinute] = useState(
    config?.scheduleMinute != null ? String(config.scheduleMinute) : "",
  );
  const [windowHours, setWindowHours] = useState(String(config?.windowHours ?? 24));
  const [maxMessages, setMaxMessages] = useState(
    config?.maxMessages != null ? String(config.maxMessages) : "",
  );
  const [cooldownSeconds, setCooldownSeconds] = useState(
    config?.cooldownSeconds != null ? String(config.cooldownSeconds) : "",
  );
  const [accessMode, setAccessMode] = useState<SummaryAccessMode>(config?.accessMode ?? "all");
  const [modelId, setModelId] = useState(config?.modelId ?? "");
  const [customPrompt, setCustomPrompt] = useState(config?.customPrompt ?? "");
  const [showDefaults, setShowDefaults] = useState(false);
  const [defaults, setDefaults] = useState<DefaultsData | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDefaults = async () => {
    if (showDefaults) {
      setShowDefaults(false);
      return;
    }
    setShowDefaults(true);
    if (!defaults) {
      setLoadingDefaults(true);
      try {
        const res = await client.api.bots[":botId"].summary.defaults.$get({
          param: { botId },
        });
        const json = await res.json();
        if (json.ok) setDefaults(json.data);
      } finally {
        setLoadingDefaults(false);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatId) return;
    setSubmitting(true);
    setError(null);
    try {
      const hourVal = scheduleHour !== "" ? Number(scheduleHour) : null;
      const minuteVal = scheduleMinute !== "" ? Number(scheduleMinute) : null;
      const payload = {
        chatId: Number(chatId),
        isActive,
        scheduleHour: hourVal,
        scheduleMinute: minuteVal,
        windowHours: Number(windowHours),
        maxMessages: maxMessages !== "" ? Number(maxMessages) : null,
        cooldownSeconds: cooldownSeconds !== "" ? Number(cooldownSeconds) : null,
        accessMode,
        modelId: modelId || null,
        customPrompt: customPrompt || null,
      };
      const res = isEdit
        ? await client.api.bots[":botId"].summary.configs[":id"].$patch({
            param: { botId, id: String(config.id) },
            json: payload,
          })
        : await client.api.bots[":botId"].summary.configs.$post({
            param: { botId },
            json: payload,
          });
      if (!res.ok) {
        setError(`Failed to ${isEdit ? "update" : "create"} config (${res.status})`);
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Chat ID *</label>
          <Input
            type="number"
            placeholder="目标群聊 ID"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            required
            disabled={isEdit}
          />
        </div>
        <div className="flex items-center gap-2 pt-5">
          <input
            type="checkbox"
            id="isActive"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="border-input h-4 w-4 rounded"
          />
          <label htmlFor="isActive" className="text-sm font-medium">
            启用
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">定时小时 (0-23)</label>
          <Input
            type="number"
            min={0}
            max={23}
            placeholder="留空 = 不定时"
            value={scheduleHour}
            onChange={(e) => setScheduleHour(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            按 AI 设置中的时区判定（默认 Asia/Shanghai）
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">定时分钟 (0-59)</label>
          <Input
            type="number"
            min={0}
            max={59}
            placeholder="留空 = 不定时"
            value={scheduleMinute}
            onChange={(e) => setScheduleMinute(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">窗口 (小时, 1-72)</label>
          <Input
            type="number"
            min={1}
            max={72}
            value={windowHours}
            onChange={(e) => setWindowHours(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-sm font-medium">最大消息数</label>
          <Input
            type="number"
            min={10}
            max={2000}
            placeholder="默认 2000"
            value={maxMessages}
            onChange={(e) => setMaxMessages(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">冷却时间 (秒)</label>
          <Input
            type="number"
            min={0}
            max={86400}
            placeholder="默认 300"
            value={cooldownSeconds}
            onChange={(e) => setCooldownSeconds(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">权限</label>
          <select
            className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
            value={accessMode}
            onChange={(e) => setAccessMode(e.target.value as SummaryAccessMode)}
          >
            <option value="all">全员</option>
            <option value="admin">仅管理员</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">模型 ID</label>
        <Input
          placeholder="留空 = 主模型"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">自定义 Prompt</label>
          <button
            type="button"
            onClick={toggleDefaults}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            {showDefaults ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            查看默认
          </button>
        </div>
        {showDefaults && (
          <div className="bg-muted rounded-md p-3 text-xs">
            {loadingDefaults ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <pre className="font-mono break-words whitespace-pre-wrap">
                {defaults?.systemPrompt ?? "—"}
              </pre>
            )}
          </div>
        )}
        <textarea
          className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="留空 = 使用全局默认 prompt"
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          rows={4}
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isEdit ? "保存" : "创建"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          取消
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
