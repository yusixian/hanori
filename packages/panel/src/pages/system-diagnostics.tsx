import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { client } from "@/lib/client";

async function readDiagnostics(signal: AbortSignal) {
  const response = await client.api.system.diagnostics.$get({}, { init: { signal } });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()).data;
}

const variants = {
  healthy: "success",
  warning: "warning",
  disabled: "muted",
  unavailable: "destructive",
} as const;

function Check({
  label,
  status,
  detail,
  fix,
}: {
  label: string;
  status: keyof typeof variants;
  detail?: string;
  fix?: string;
}) {
  const { t } = useTranslation("auth");
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-3">
      <span className="font-medium">{label}</span>
      <Badge variant={variants[status]}>{t(`diagnostics.${status}`)}</Badge>
      {detail && (
        <code className="text-muted-foreground col-span-2 text-sm break-all">{detail}</code>
      )}
      {fix && (status === "warning" || status === "unavailable") && (
        <p className="text-muted-foreground col-span-2 text-sm">{fix}</p>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <ul className="divide-y">{children}</ul>
      </CardContent>
    </Card>
  );
}

export default function SystemDiagnosticsPage() {
  const { t } = useTranslation("auth");
  const d = (key: string) => t(`diagnostics.${key}`);
  const [generation, setGeneration] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<typeof readDiagnostics>>>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError("");
    void readDiagnostics(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setData(undefined);
        setError(cause instanceof Error && cause.message === "403" ? "forbidden" : "failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [generation]);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <a className="text-muted-foreground text-sm underline" href="/settings">
        {t("settings.title")}
      </a>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{d("title")}</h1>
        <Button variant="outline" disabled={pending} onClick={() => setGeneration((n) => n + 1)}>
          <RefreshCw size={16} aria-hidden="true" />
          {d("refresh")}
        </Button>
      </header>
      {pending && <p role="status">{d("loading")}</p>}
      {error && <p role="alert">{d(error)}</p>}
      {data && (
        <>
          <Section title={d("deployment")}>
            <Check
              label={d("version")}
              status={data.version === "unknown" ? "warning" : "healthy"}
              detail={data.version === "unknown" ? d("unknown") : data.version}
              fix={d("versionFix")}
            />
            <Check
              label={d("runtime")}
              status={data.status === "ready" ? "healthy" : "warning"}
              detail={d(data.mode) + " · " + d(data.status)}
              fix={d("runtimeFix")}
            />
            <Check
              label={d("database")}
              status={data.databaseReady ? "healthy" : "unavailable"}
              fix={d("databaseFix")}
            />
            <Check
              label={d("migrations")}
              status={data.migrationsReady ? "healthy" : "unavailable"}
              fix={d("migrationsFix")}
            />
          </Section>
          <Section title={d("security")}>
            <Check
              label={d("protocol")}
              status={data.protocolMatches ? "healthy" : "warning"}
              detail={t("diagnostics.protocolDetail", {
                origin: data.authOrigin,
                request: data.requestProtocol,
                forwarded:
                  data.forwardedProtocol === "unknown"
                    ? d("unknown")
                    : (data.forwardedProtocol ?? d("absent")),
              })}
              fix={d("protocolFix")}
            />
            <Check
              label={d("password")}
              status={data.panelPasswordPresent ? "warning" : "healthy"}
              fix={d("passwordFix")}
            />
            <Check
              label={d("secret")}
              status={data.independentMiniAppSecret ? "healthy" : "warning"}
              fix={d("secretFix")}
            />
            <Check
              label={d("https")}
              status={data.httpsOrigin ? "healthy" : "warning"}
              fix={d("httpsFix")}
            />
          </Section>
          <Section title={d("integrations")}>
            {Object.entries(data.integrations).map(([name, state]) => (
              <Check
                key={name}
                label={name}
                status={state === "reachable" ? "healthy" : state}
                fix={d(name + "Fix")}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
