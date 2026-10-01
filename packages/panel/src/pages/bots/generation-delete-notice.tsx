import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

export type GenerationNoticeKind =
  | "unknown"
  | "deleted-refresh-failed"
  | "deleted"
  | "missing"
  | "active"
  | "bot-missing";

export function GenerationDeleteNotice({
  kind,
  busy,
  onRecover,
}: {
  kind: GenerationNoticeKind;
  busy: boolean;
  onRecover: () => void;
}) {
  const { t } = useTranslation("botData");
  const needsRecovery =
    kind === "unknown" ||
    kind === "deleted-refresh-failed" ||
    kind === "active" ||
    kind === "bot-missing";
  const key =
    kind === "unknown"
      ? "generations.deleteUnconfirmed"
      : kind === "deleted-refresh-failed"
        ? "generations.deletedRefreshFailed"
        : kind === "active"
          ? "generations.activeConflict"
          : kind === "bot-missing"
            ? "generations.botUnavailable"
            : kind === "missing"
              ? "generations.recordMissing"
              : "common.deleted";
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${needsRecovery ? "border-warning-border bg-warning-soft text-warning" : "border-success-border bg-success-soft text-success"}`}
      role={needsRecovery ? "alert" : "status"}
    >
      <span className="flex items-center gap-2">
        {needsRecovery ? <AlertTriangle className="size-4 shrink-0" aria-hidden="true" /> : null}
        {t(key)}
      </span>
      {needsRecovery ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={onRecover}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-4" aria-hidden="true" />
          )}
          {t(busy ? "generations.refreshing" : "generations.refreshAndCheck")}
        </Button>
      ) : null}
    </div>
  );
}
