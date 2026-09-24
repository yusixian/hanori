import type { HarnessAdminOverview } from "@cos-tool-bot/shared";
import { useMemo } from "react";
import { HarnessAdminScreen } from "@/components/harness/harness-admin-screen";
import { createMiniAppHarnessAdminApi } from "@/lib/harness-admin-client";
import type { MiniAppSessionView } from "./session";

/** Hands links to Telegram so t.me topics open in-app and GitHub opens in the external browser. */
export function openTelegramAwareLink(url: string): boolean {
  const webApp = window.Telegram?.WebApp;
  if (url.startsWith("https://t.me/") && webApp?.openTelegramLink) {
    webApp.openTelegramLink(url);
    return true;
  }
  if (webApp?.openLink) {
    webApp.openLink(url);
    return true;
  }
  return false;
}

export function HarnessPage({
  botId,
  session,
  initialOverview,
}: {
  botId: string;
  session: MiniAppSessionView;
  initialOverview?: HarnessAdminOverview;
}) {
  const api = useMemo(
    () => createMiniAppHarnessAdminApi(botId, session.csrfToken),
    [botId, session.csrfToken],
  );
  return (
    <main className="mini-app-content">
      <HarnessAdminScreen
        api={api}
        basePath={`/mini-app/${botId}/harness`}
        surface="mini-app"
        initialOverview={initialOverview}
        onOpenLink={openTelegramAwareLink}
      />
    </main>
  );
}
