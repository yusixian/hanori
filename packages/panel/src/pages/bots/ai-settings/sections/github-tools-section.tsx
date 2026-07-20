import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { GitHubToolsConfigPublic } from "@cos-tool-bot/shared";
import { useTranslation } from "react-i18next";

export function GitHubToolsSection({
  config,
  token,
  onTokenChange,
  onUpdate,
}: {
  config: GitHubToolsConfigPublic;
  token: string;
  onTokenChange: (token: string) => void;
  onUpdate: (updates: Partial<GitHubToolsConfigPublic>) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Switch
          id="githubToolsEnabled"
          checked={config.enabled}
          onCheckedChange={(enabled) => onUpdate({ enabled })}
        />
        <label htmlFor="githubToolsEnabled" className="text-sm font-medium">
          {t("githubTools.enable")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("githubTools.securityDescription")}</p>

      <div className="flex items-center gap-2">
        <Switch
          id="githubPublicReadEnabled"
          disabled={!config.enabled}
          checked={config.publicReadEnabled}
          onCheckedChange={(publicReadEnabled) => onUpdate({ publicReadEnabled })}
        />
        <label htmlFor="githubPublicReadEnabled" className="text-sm font-medium">
          {t("githubTools.publicRead")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("githubTools.publicReadDescription")}</p>

      <div className="flex items-center gap-2">
        <Switch
          id="githubCodingAgentEnabled"
          disabled={!config.enabled}
          checked={config.codingAgentEnabled}
          onCheckedChange={(codingAgentEnabled) => onUpdate({ codingAgentEnabled })}
        />
        <label htmlFor="githubCodingAgentEnabled" className="text-sm font-medium">
          {t("githubTools.codingAgent")}
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("githubTools.codingAgentDescription")}</p>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("githubTools.login")}</label>
          <Input
            disabled={!config.enabled}
            value={config.login ?? ""}
            onChange={(event) => onUpdate({ login: event.target.value || undefined })}
            placeholder="ai-chan"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("githubTools.token")}</label>
          <Input
            type="password"
            autoComplete="new-password"
            disabled={!config.enabled}
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder={
              config.hasToken
                ? t("githubTools.keepTokenPlaceholder")
                : t("githubTools.tokenPlaceholder")
            }
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("githubTools.authorName")}</label>
          <Input
            disabled={!config.enabled}
            value={config.authorName}
            onChange={(event) => onUpdate({ authorName: event.target.value })}
            placeholder="Ai-chan"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("githubTools.authorEmail")}</label>
          <Input
            type="email"
            disabled={!config.enabled}
            value={config.authorEmail}
            onChange={(event) => onUpdate({ authorEmail: event.target.value })}
            placeholder="ai-chan@users.noreply.github.com"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t("githubTools.repositories")}</label>
        <Textarea
          disabled={!config.enabled}
          value={config.repositories.join("\n")}
          onChange={(event) =>
            onUpdate({
              repositories: event.target.value
                .split(/[,\n]/)
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean),
            })
          }
          placeholder={"owner/repository\nowner/private-repository"}
          rows={5}
        />
        <p className="text-muted-foreground text-xs">{t("githubTools.repositoriesDescription")}</p>
      </div>

      <div className="bg-muted/40 rounded-md border p-3 text-xs">
        <p className="font-medium">{t("githubTools.tokenPermissionsTitle")}</p>
        <p className="text-muted-foreground mt-1">{t("githubTools.tokenPermissions")}</p>
      </div>
    </div>
  );
}
