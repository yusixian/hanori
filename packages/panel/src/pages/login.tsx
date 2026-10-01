import { Button } from "@/components/ui/button";
import { HanoriMark } from "@/components/hanori-mark";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import sakura from "../../../docs/public/docs/brand/hanori-sakura-v1.webp";
import { authClient } from "@/lib/auth-client";
import { authFetch } from "@/lib/client";
import { LockKeyhole, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

export function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get("returnTo"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Sign in directly instead of via refine's useLogin: a failed attempt triggers an
  // auth-check refetch that remounts this page, which would discard the error state.
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await authClient.signIn.email({ email, password });
      if ("error" in result && result.error) {
        setError(result.error.message || t("errors.loginFailed"));
        return;
      }
      const membership = await authFetch("/api/authz/me");
      if (!membership.ok) {
        await authClient.signOut().catch(() => undefined);
        setError(t("errors.membershipRequired"));
        return;
      }
      navigate(returnTo, { replace: true });
    } catch {
      setError(t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <header className="login-topbar">
        <div className="login-wordmark">
          <HanoriMark className="size-11" />
          <span>{t("common:app.name")}</span>
        </div>
        <LanguageSwitcher />
      </header>
      <main className="login-main">
        <section className="login-intro" aria-labelledby="login-headline">
          <div className="login-scene" aria-hidden="true">
            <img src={sakura} alt="" width={1536} height={1024} fetchPriority="high" />
          </div>
          <p className="login-eyebrow">{t("common:app.subtitle")}</p>
          <h1 id="login-headline">{t("login.headline")}</h1>
          <p className="login-intro-description">{t("login.companionDescription")}</p>
        </section>
        <Card className="login-card">
          <CardHeader className="px-7 pt-8">
            <CardTitle className="text-xl">{t("login.title")}</CardTitle>
            <CardDescription>{t("login.description")}</CardDescription>
          </CardHeader>
          <CardContent className="px-7 pb-8">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {error && (
                <div
                  role="alert"
                  className="border-danger-border bg-danger-soft text-destructive rounded-lg border px-3 py-2 text-sm"
                >
                  {error}
                </div>
              )}
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("login.emailLabel")}</span>
                <div className="relative">
                  <Mail className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2" />
                  <Input
                    className="pl-10"
                    type="email"
                    placeholder={t("login.emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    autoFocus
                  />
                </div>
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("login.passwordLabel")}</span>
                <div className="relative">
                  <LockKeyhole className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2" />
                  <Input
                    className="pl-10"
                    type="password"
                    placeholder={t("login.passwordPlaceholder")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              </label>
              <Button type="submit" disabled={loading || !email || !password}>
                {loading ? t("login.submitting") : t("login.submit")}
              </Button>
              <div className="text-muted-foreground flex items-center gap-3 text-xs">
                <div className="bg-border h-px flex-1" />
                <span>{t("login.separator")}</span>
                <div className="bg-border h-px flex-1" />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  authClient.signIn.social({
                    provider: "google",
                    callbackURL: `${window.location.origin}${returnTo}`,
                  })
                }
              >
                {t("login.google")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
      <footer className="login-footer text-muted-foreground flex items-center gap-4 text-sm">
        <a
          href="/docs/"
          className="hover:text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {t("common:navigation.documentation")}
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="/docs/changelog/"
          className="hover:text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {t("common:navigation.changelog")}
        </a>
      </footer>
    </div>
  );
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
