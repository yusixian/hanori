import { useId } from "react";
import { useTranslation } from "react-i18next";

export function YtdlpSetupGuide() {
  const { t } = useTranslation("plugins");
  const id = useId();
  return (
    <section aria-labelledby={id} className="bg-muted/40 space-y-3 rounded-xl border p-4 text-sm">
      <h3 id={id} className="font-semibold">
        {t("ytdlp.startTitle")}
      </h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>{t("ytdlp.startAnonymous")}</li>
        <li>{t("ytdlp.startSave")}</li>
        <li>{t("ytdlp.startTry")}</li>
      </ol>
      <p className="text-muted-foreground">{t("ytdlp.subtitleHint")}</p>
      <p className="text-muted-foreground border-t pt-3">{t("ytdlp.testHint")}</p>
    </section>
  );
}

export function YtdlpCookiesHelp() {
  const { t } = useTranslation("plugins");
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="focus-visible:ring-ring cursor-pointer rounded font-medium focus-visible:ring-2 focus-visible:outline-none">
        {t("ytdlp.cookiesHelpTitle")}
      </summary>
      <div className="mt-3 space-y-3 [overflow-wrap:anywhere]">
        <ol className="list-decimal space-y-2 pl-5">
          <li>{t("ytdlp.cookiesExport")}</li>
          <li>{t("ytdlp.cookiesPaste")}</li>
          <li>{t("ytdlp.cookiesSave")}</li>
        </ol>
        <p className="text-muted-foreground">{t("ytdlp.cookiesPrivacy")}</p>
        <a
          href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary inline-block underline underline-offset-4"
        >
          {t("ytdlp.cookiesGuide")}
        </a>
      </div>
    </details>
  );
}
