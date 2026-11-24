import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePanelRole } from "@/hooks/use-can-manage-bot";
import type { BotWithStatus } from "@cos-tool-bot/shared";
import { useList } from "@refinedev/core";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { ChevronDown, Circle, CircleCheck, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

const dismissedAtom = atomWithStorage("hanori.onboarding.dismissed", false, undefined, {
  getOnInit: true,
});
const securityAtom = atomWithStorage("hanori.onboarding.security", false, undefined, {
  getOnInit: true,
});

type BotPage = { data: BotWithStatus[]; total: number };
type Progress = { provider: boolean; active: boolean; firstBot?: string };

export function OnboardingChecklist({
  firstPage,
  pageSize,
}: {
  firstPage: BotPage;
  pageSize: number;
}) {
  const [dismissed] = useAtom(dismissedAtom);
  const role = usePanelRole();
  if (dismissed || role !== "owner") return null;
  return (
    <ChecklistPage
      result={firstPage}
      page={1}
      pageSize={pageSize}
      previous={{ provider: false, active: false }}
    />
  );
}

function ChecklistPage({
  result,
  page,
  pageSize,
  previous,
}: {
  result: BotPage;
  page: number;
  pageSize: number;
  previous: Progress;
}) {
  const progress = {
    provider: previous.provider || result.data.some((bot) => bot.aiHasApiKey),
    active: previous.active || result.data.some((bot) => bot.isActive || bot.status === "running"),
    firstBot: previous.firstBot ?? result.data[0]?.id,
  };
  if (
    !(progress.provider && progress.active) &&
    result.data.length &&
    page * pageSize < result.total
  ) {
    return <NextChecklistPage page={page + 1} pageSize={pageSize} previous={progress} />;
  }
  return <ChecklistCard {...progress} />;
}

function NextChecklistPage({
  page,
  pageSize,
  previous,
}: {
  page: number;
  pageSize: number;
  previous: Progress;
}) {
  const { data } = useList<BotWithStatus>({
    resource: "bots",
    pagination: { current: page, pageSize },
    filters: [],
    queryOptions: { keepPreviousData: false },
  });
  return data ? (
    <ChecklistPage result={data} page={page} pageSize={pageSize} previous={previous} />
  ) : null;
}

function ChecklistCard({ provider, active, firstBot }: Progress) {
  const { t } = useTranslation("bots");
  const [security, setSecurity] = useAtom(securityAtom);
  const [, setDismissed] = useAtom(dismissedAtom);
  const [expanded, setExpanded] = useState<boolean>();
  const count = Number(security) + Number(provider) + Number(active);
  const open = expanded ?? count < 3;
  const steps = [
    {
      title: t("onboarding.security"),
      done: security,
      href: "/settings#account-security",
      action: t("onboarding.settings"),
    },
    {
      title: t("onboarding.provider"),
      done: provider,
      href: firstBot ? `/bots/${firstBot}/ai?section=providers` : "/bots/new",
      action: t(firstBot ? "onboarding.configure" : "onboarding.createForProvider"),
    },
    {
      title: t("onboarding.bot"),
      done: active,
      href: firstBot ? `/bots/${firstBot}/edit` : "/bots/new",
      action: t(firstBot ? "onboarding.edit" : "onboarding.create"),
    },
  ];
  return (
    <Card role="region" aria-labelledby="onboarding-title" className="px-4 sm:px-5">
      <div className="flex items-center justify-between gap-2 py-2">
        <h2 id="onboarding-title">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="onboarding-steps"
            onClick={() => setExpanded(!open)}
            className="flex min-h-10 flex-wrap items-center gap-2 rounded text-left font-semibold"
          >
            <ChevronDown aria-hidden="true" className={`size-4 ${open ? "" : "-rotate-90"}`} />
            {t("onboarding.title")}
            <span className="text-muted-foreground text-sm font-normal">
              {t("onboarding.progress", { count })}
            </span>
          </button>
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("onboarding.dismiss")}
          title={t("onboarding.dismiss")}
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" />
        </Button>
      </div>
      <ol id="onboarding-steps" hidden={!open} className="divide-y border-t text-sm">
        {steps.map(({ title, done, href, action }, i) => {
          const Icon = done ? CircleCheck : Circle;
          return (
            <li key={href + i} className="flex items-start gap-3 py-3">
              <Icon
                aria-hidden="true"
                className={`mt-0.5 size-4 shrink-0 ${done ? "text-success" : "text-muted-foreground"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {title}
                  <span className="sr-only">
                    {" "}
                    · {t(done ? "onboarding.done" : "onboarding.pending")}
                  </span>
                </p>
                {i === 0 && (
                  <p className="text-muted-foreground mt-1">{t("onboarding.securityHint")}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {(!done || i === 0) && (
                    <Link
                      to={href}
                      className="text-primary inline-flex min-h-8 items-center underline underline-offset-2"
                    >
                      {action}
                    </Link>
                  )}
                  {i === 0 && (
                    <label className="flex min-h-8 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={security}
                        onChange={(e) => setSecurity(e.target.checked)}
                      />
                      {t("onboarding.confirm")}
                    </label>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
