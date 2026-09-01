import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { authFetch } from "@/lib/client";
import { Bot, LockKeyhole, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

export function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
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
      navigate("/", { replace: true });
    } catch {
      setError(t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-5">
      <div className="pointer-events-none absolute -top-32 left-1/2 size-[34rem] -translate-x-1/2 rounded-full bg-blue-200/40 blur-3xl" />
      <Card className="relative w-full max-w-[420px]">
        <CardHeader className="items-center px-7 pt-8 text-center">
          <div className="bg-primary mb-3 flex size-12 items-center justify-center rounded-2xl text-white shadow-lg shadow-blue-600/20">
            <Bot className="h-6 w-6" />
          </div>
          <CardTitle className="text-xl">{t("login.title")}</CardTitle>
          <CardDescription>{t("login.description")}</CardDescription>
        </CardHeader>
        <CardContent className="px-7 pb-8">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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
                  callbackURL: `${window.location.origin}/`,
                })
              }
            >
              {t("login.google")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
