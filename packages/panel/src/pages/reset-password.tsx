import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

export function ResetPasswordPage() {
  const { t } = useTranslation("auth");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError(t("errors.passwordMismatch"));
      return;
    }
    const response = await fetch("/api/authz/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: password }),
    });
    if (!response.ok) {
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        setError(body.error || body.message || t("errors.resetPasswordFailed"));
      } catch {
        setError(t("errors.resetPasswordFailed"));
      }
      return;
    }
    setMessage(t("resetPassword.success"));
    setTimeout(() => navigate("/login", { replace: true }), 1200);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-5">
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle>{t("resetPassword.title")}</CardTitle>
          <CardDescription>{t("resetPassword.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="bg-danger-soft text-destructive mb-4 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {message && (
            <div className="bg-success-soft text-success mb-4 rounded-lg px-3 py-2 text-sm">
              {message}
            </div>
          )}
          <form onSubmit={submit} className="grid gap-4">
            <Input
              type="password"
              placeholder={t("resetPassword.newPasswordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
            <Input
              type="password"
              placeholder={t("resetPassword.confirmPasswordPlaceholder")}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              required
            />
            <Button type="submit" disabled={!token || !!message}>
              {t("resetPassword.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
