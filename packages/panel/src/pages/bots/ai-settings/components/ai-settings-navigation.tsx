import { cn } from "@/lib/utils";
import { SelectMenu } from "@/components/ui/select-menu";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

export type AiSettingsSectionId =
  | "overview"
  | "providers"
  | "replies"
  | "memory"
  | "tools"
  | "access";

export interface AiSettingsNavItem {
  id: AiSettingsSectionId;
  label: string;
  description: string;
  icon: LucideIcon;
}

export function AiSettingsNavigation({
  items,
  activeId,
  onChange,
}: {
  items: AiSettingsNavItem[];
  activeId: AiSettingsSectionId;
  onChange: (id: AiSettingsSectionId) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <>
      <div className="ai-settings-mobile-nav">
        <label htmlFor="ai-settings-section" className="sr-only">
          {t("navigation.settingsSection")}
        </label>
        <SelectMenu
          id="ai-settings-section"
          value={activeId}
          onValueChange={(value) => onChange(value as AiSettingsSectionId)}
          className="border-input h-10 w-full rounded-lg border bg-white px-3 text-sm font-medium"
          ariaLabel={t("navigation.settingsSection")}
          options={items.map((item) => ({ value: item.id, label: item.label }))}
        />
      </div>

      <nav aria-label={t("navigation.ariaLabel")} className="ai-settings-desktop-nav">
        <div className="flex flex-wrap gap-1">
          {items.map((item) => {
            const active = activeId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onChange(item.id)}
                className={cn(
                  "focus-visible:ring-ring flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-center transition-[background-color,color] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                  active
                    ? "bg-accent text-accent-foreground shadow-[inset_0_-2px_0_var(--color-primary)]"
                    : "text-muted-foreground hover:bg-surface-subtle hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center",
                    active ? "text-accent-foreground" : "text-muted-foreground",
                  )}
                >
                  <item.icon className="size-4" />
                </span>
                <span className="text-xs font-medium xl:text-sm">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
