import { cn } from "@/lib/utils";
import { SelectMenu } from "@/components/ui/select-menu";
import type { LucideIcon } from "lucide-react";

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
  return (
    <>
      <div className="md:hidden">
        <label htmlFor="ai-settings-section" className="sr-only">
          Settings section
        </label>
        <SelectMenu
          id="ai-settings-section"
          value={activeId}
          onValueChange={(value) => onChange(value as AiSettingsSectionId)}
          className="border-input h-11 w-full rounded-xl border bg-white px-3 text-sm font-medium shadow-sm"
          ariaLabel="Settings section"
          options={items.map((item) => ({ value: item.id, label: item.label }))}
        />
      </div>

      <nav aria-label="AI settings sections" className="hidden md:block">
        <div className="flex flex-wrap gap-2">
          {items.map((item) => {
            const active = activeId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onChange(item.id)}
                className={cn(
                  "flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2 text-center transition-[background-color,color,box-shadow,transform] active:scale-[0.96]",
                  active
                    ? "bg-blue-600 text-white shadow-[0_6px_16px_rgb(37_99_235/0.22)]"
                    : "bg-white text-slate-600 shadow-sm ring-1 ring-slate-950/[0.05] hover:bg-slate-50 hover:text-slate-950",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center",
                    active ? "text-white" : "text-slate-400",
                  )}
                >
                  <item.icon className="size-4" />
                </span>
                <span className="truncate text-xs font-semibold xl:text-sm">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
