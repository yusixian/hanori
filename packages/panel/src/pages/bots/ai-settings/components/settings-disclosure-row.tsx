import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { EmbeddedCardProvider } from "@/components/ui/card";
import { useEffect, useState, type ReactNode } from "react";
import { settingElementId, type AiSettingId } from "../settings-index";

export function SettingsDisclosureRow({
  title,
  description,
  summary,
  settingId,
  reveal = false,
  onOpenChange,
  defaultOpen = false,
  flattenCard = true,
  children,
}: {
  title: string;
  description?: string;
  summary?: ReactNode;
  settingId: AiSettingId;
  reveal?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  flattenCard?: boolean;
  children: ReactNode;
}) {
  const [value, setValue] = useState(defaultOpen || reveal ? "content" : "");

  useEffect(() => {
    if (reveal) setValue("content");
  }, [reveal]);

  return (
    <div id={settingElementId(settingId)} className="scroll-mt-52">
      <Accordion
        type="single"
        collapsible
        value={value}
        onValueChange={(nextValue) => {
          setValue(nextValue);
          onOpenChange?.(nextValue === "content");
        }}
      >
        <AccordionItem
          value="content"
          className="rounded-2xl bg-white shadow-[var(--shadow-surface)] ring-1 ring-slate-950/[0.04] data-[state=open]:ring-blue-600/15"
        >
          <AccordionTrigger
            id={`${settingElementId(settingId)}-trigger`}
            className="relative min-h-20 gap-4 px-5 py-4 data-[state=open]:bg-blue-50/45 sm:px-6"
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-4 left-0 w-[3px] rounded-r-full bg-blue-600 opacity-0 transition-opacity group-data-[state=open]:opacity-100"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-950 group-data-[state=open]:text-blue-950">
                {title}
              </span>
              {description && (
                <span className="mt-1 block text-xs leading-5 text-pretty text-slate-500">
                  {description}
                </span>
              )}
              {summary && (
                <span className="mt-2 inline-flex max-w-full rounded-full bg-slate-100 px-2.5 py-1 text-[11px] leading-4 font-semibold text-slate-600 lg:hidden">
                  {summary}
                </span>
              )}
            </span>
            {summary && (
              <span className="hidden shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 lg:block">
                {summary}
              </span>
            )}
          </AccordionTrigger>
          <AccordionContent className="border-t border-slate-100 bg-white px-5 py-5 sm:px-6">
            {flattenCard ? <EmbeddedCardProvider>{children}</EmbeddedCardProvider> : children}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
