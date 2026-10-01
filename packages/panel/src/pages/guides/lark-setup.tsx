import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base">
          <span className="bg-primary text-primary-foreground inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold">
            {number}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm leading-relaxed">{children}</CardContent>
    </Card>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

export function LarkSetupGuidePage() {
  const { t } = useTranslation("admin");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("larkGuide.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("larkGuide.subtitle")}</p>
      </div>

      <div className="space-y-4">
        <Step number={1} title={t("larkGuide.steps.create.title")}>
          <ol className="list-inside list-decimal space-y-2">
            <li>{t("larkGuide.steps.create.openChat")}</li>
            <li>{t("larkGuide.steps.create.openSettings")}</li>
            <li>{t("larkGuide.steps.create.botsSection")}</li>
            <li>{t("larkGuide.steps.create.addBot")}</li>
            <li>{t("larkGuide.steps.create.nameBot")}</li>
          </ol>
        </Step>

        <Step number={2} title={t("larkGuide.steps.webhook.title")}>
          <p>{t("larkGuide.steps.webhook.intro")}</p>
          <div className="bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs">
            https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
          </div>
          <p className="mt-2">{t("larkGuide.steps.webhook.copy")}</p>
        </Step>

        <Step number={3} title={t("larkGuide.steps.signature.title")}>
          <p>{t("larkGuide.steps.signature.intro")}</p>
          <ol className="mt-2 list-inside list-decimal space-y-2">
            <li>{t("larkGuide.steps.signature.findSecurity")}</li>
            <li>{t("larkGuide.steps.signature.enable")}</li>
            <li>{t("larkGuide.steps.signature.copySecret")}</li>
          </ol>
          <p className="text-muted-foreground mt-2">{t("larkGuide.steps.signature.skip")}</p>
        </Step>

        <Step number={4} title={t("larkGuide.steps.panel.title")}>
          <p>{t("larkGuide.steps.panel.intro")}</p>
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">
                {t("larkGuide.steps.panel.platform")}
              </span>
              <span>{t("larkGuide.steps.panel.platformValue")}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">
                {t("larkGuide.steps.panel.name")}
              </span>
              <span>{t("larkGuide.steps.panel.nameValue")}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">
                {t("larkGuide.steps.panel.webhookUrl")}
              </span>
              <span>{t("larkGuide.steps.panel.webhookValue")}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">
                {t("larkGuide.steps.panel.signSecret")}
              </span>
              <span>{t("larkGuide.steps.panel.signSecretValue")}</span>
            </div>
          </div>
        </Step>

        <Step number={5} title={t("larkGuide.steps.email.title")}>
          <p>{t("larkGuide.steps.email.intro")}</p>

          <h4 className="mt-3 font-medium">{t("larkGuide.steps.email.gmailTitle")}</h4>
          <ol className="mt-1 list-inside list-decimal space-y-2">
            <li>{t("larkGuide.steps.email.gmailEnable")}</li>
            <li>{t("larkGuide.steps.email.gmailTwoStep")}</li>
            <li>
              {t("larkGuide.steps.email.gmailPassword")}{" "}
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {t("larkGuide.steps.email.googleAppPasswords")}
              </a>{" "}
              {t("larkGuide.steps.email.gmailPasswordAction")}
            </li>
            <li>{t("larkGuide.steps.email.gmailCopy")}</li>
          </ol>
          <div className="bg-muted mt-2 space-y-1 rounded-md p-3 font-mono text-xs">
            <div>
              {t("larkGuide.steps.email.host")} <strong>imap.gmail.com</strong>
            </div>
            <div>
              {t("larkGuide.steps.email.port")} <strong>993</strong>
            </div>
          </div>

          <h4 className="mt-3 font-medium">{t("larkGuide.steps.email.qqTitle")}</h4>
          <ol className="mt-1 list-inside list-decimal space-y-2">
            <li>{t("larkGuide.steps.email.qqSettings")}</li>
            <li>{t("larkGuide.steps.email.qqEnable")}</li>
            <li>{t("larkGuide.steps.email.qqCode")}</li>
          </ol>
          <div className="bg-muted mt-2 space-y-1 rounded-md p-3 font-mono text-xs">
            <div>
              {t("larkGuide.steps.email.host")} <strong>imap.qq.com</strong>
            </div>
            <div>
              {t("larkGuide.steps.email.port")} <strong>993</strong>
            </div>
          </div>

          <h4 className="mt-3 font-medium">{t("larkGuide.steps.email.filterTitle")}</h4>
          <ul className="mt-1 list-inside list-disc space-y-1">
            <li>
              <strong>{t("larkGuide.steps.email.senderFilter")}</strong> — e.g.{" "}
              <Code>notifications@github.com</Code>
            </li>
            <li>
              <strong>{t("larkGuide.steps.email.subjectFilter")}</strong> — e.g.{" "}
              <Code>pull request</Code>
            </li>
          </ul>
          <p className="text-muted-foreground mt-2">{t("larkGuide.steps.email.filterHint")}</p>
        </Step>

        <Step number={6} title={t("larkGuide.steps.test.title")}>
          <ol className="list-inside list-decimal space-y-2">
            <li>{t("larkGuide.steps.test.start")}</li>
            <li>{t("larkGuide.steps.test.send")}</li>
            <li>{t("larkGuide.steps.test.check")}</li>
          </ol>
          <p className="text-muted-foreground mt-2">{t("larkGuide.steps.test.troubleshoot")}</p>
        </Step>
      </div>

      <div className="flex justify-center pt-2">
        <Link to="/bots/new">
          <Button size="lg">{t("larkGuide.createBot")}</Button>
        </Link>
      </div>
    </div>
  );
}
