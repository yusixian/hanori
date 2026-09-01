import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

async function acceptInvitation(
  invitationId: string,
  fallbackMessage: string,
): Promise<string | null> {
  const response = await fetch("/api/auth/organization/accept-invitation", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitationId }),
  });
  if (response.ok) return null;
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message || body.error || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

export function AcceptInvitationPage() {
  const { t } = useTranslation("auth");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const invitationId = params.get("id") || "";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!invitationId) return;
    void (async () => {
      const result = await authClient.getSession();
      if (!("data" in result) || !result.data?.user) return;
      setLoading(true);
      const message = await acceptInvitation(invitationId, t("errors.invitationAcceptFailed"));
      if (message) setError(message);
      else navigate("/", { replace: true });
      setLoading(false);
    })();
  }, [invitationId, navigate]);

  const signUp = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    const result = await authClient.signUp.email({ name, email, password });
    if ("error" in result && result.error) {
      setError(result.error.message || t("errors.signUpFailed"));
      setLoading(false);
      return;
    }
    const message = await acceptInvitation(invitationId, t("errors.invitationAcceptFailed"));
    if (message) setError(message);
    else navigate("/", { replace: true });
    setLoading(false);
  };

  const signIn = async () => {
    setError("");
    setLoading(true);
    const result = await authClient.signIn.email({ email, password });
    if ("error" in result && result.error) {
      setError(result.error.message || t("errors.loginFailed"));
      setLoading(false);
      return;
    }
    const message = await acceptInvitation(invitationId, t("errors.invitationAcceptFailed"));
    if (message) setError(message);
    else navigate("/", { replace: true });
    setLoading(false);
  };

  if (!invitationId)
    return (
      <div className="flex min-h-screen items-center justify-center p-5">
        <p className="max-w-md text-center text-sm text-red-600">{t("invitation.missingId")}</p>
      </div>
    );

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-5">
      <Card className="relative w-full max-w-[440px]">
        <CardHeader>
          <CardTitle>{t("invitation.title")}</CardTitle>
          <CardDescription>{t("invitation.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <form onSubmit={signUp} className="grid gap-3">
            <Input
              placeholder={t("invitation.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Input
              type="email"
              placeholder={t("invitation.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <Input
              type="password"
              placeholder={t("invitation.passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
              required
            />
            <Button type="submit" disabled={loading}>
              {t("invitation.signUpAndJoin")}
            </Button>
          </form>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => void signIn()}
            disabled={loading || !email || !password}
          >
            {t("invitation.signInAndJoin")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() =>
              authClient.signIn.social({ provider: "google", callbackURL: window.location.href })
            }
            disabled={loading}
          >
            {t("invitation.googleSignInAndJoin")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
