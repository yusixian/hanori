import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SummaryConfigStored } from "@cos-tool-bot/shared";
import { Link } from "react-router";

export function SummaryConfigSection({
  botId,
  config,
  onUpdate,
}: {
  botId: string;
  config: SummaryConfigStored;
  onUpdate: (updates: Partial<SummaryConfigStored>) => void;
}) {
  const roleOptions: Array<"user" | "context" | "assistant"> = ["user", "context", "assistant"];
  const currentRoleFilter = config.roleFilter ?? ["user", "context", "assistant"];

  const toggleRole = (role: "user" | "context" | "assistant") => {
    const next = currentRoleFilter.includes(role)
      ? currentRoleFilter.filter((r) => r !== role)
      : [...currentRoleFilter, role];
    onUpdate({ roleFilter: next });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">群聊总结</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          全局默认配置。每个群聊的具体参数（chatId、定时、窗口等）在{" "}
          <Link to={`/bots/${botId}/summary`} className="underline hover:opacity-80">
            群聊总结页面
          </Link>{" "}
          管理。
        </p>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="summaryEnabled"
            checked={config.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            className="border-input h-4 w-4 rounded"
          />
          <label htmlFor="summaryEnabled" className="text-sm font-medium">
            启用群聊总结功能
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">默认窗口 (小时)</label>
            <Input
              type="number"
              min={1}
              max={72}
              value={config.defaultWindowHours}
              onChange={(e) => onUpdate({ defaultWindowHours: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">默认最大消息数</label>
            <Input
              type="number"
              min={10}
              max={2000}
              value={config.defaultMaxMessages}
              onChange={(e) => onUpdate({ defaultMaxMessages: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">默认冷却 (秒)</label>
            <Input
              type="number"
              min={0}
              max={86400}
              value={config.defaultCooldownSeconds}
              onChange={(e) => onUpdate({ defaultCooldownSeconds: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">时区</label>
            <Input
              placeholder="Asia/Shanghai"
              value={config.timezone ?? ""}
              onChange={(e) => onUpdate({ timezone: e.target.value || undefined })}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">全局定时小时 (0-23)</label>
            <Input
              type="number"
              min={0}
              max={23}
              placeholder="留空 = 不设全局定时"
              value={config.globalScheduleHour != null ? String(config.globalScheduleHour) : ""}
              onChange={(e) =>
                onUpdate({
                  globalScheduleHour: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">全局定时分钟 (0-59)</label>
            <Input
              type="number"
              min={0}
              max={59}
              placeholder="留空 = 不设全局定时"
              value={config.globalScheduleMinute != null ? String(config.globalScheduleMinute) : ""}
              onChange={(e) =>
                onUpdate({
                  globalScheduleMinute: e.target.value !== "" ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">模型 ID (可选)</label>
          <Input
            placeholder="留空 = 使用主模型"
            value={config.modelId ?? ""}
            onChange={(e) => onUpdate({ modelId: e.target.value || undefined })}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">消息角色过滤</label>
          <div className="flex gap-4">
            {roleOptions.map((role) => (
              <label key={role} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={currentRoleFilter.includes(role)}
                  onChange={() => toggleRole(role)}
                  className="border-input h-4 w-4 rounded"
                />
                {role}
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">系统 Prompt (可选)</label>
          <textarea
            className="border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="留空 = 使用内置默认 prompt"
            value={config.systemPrompt ?? ""}
            onChange={(e) => onUpdate({ systemPrompt: e.target.value || undefined })}
            rows={4}
          />
        </div>
      </CardContent>
    </Card>
  );
}
