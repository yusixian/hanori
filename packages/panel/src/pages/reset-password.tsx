import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";

export function ResetPasswordPage() {
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
      setError("两次输入的密码不一致");
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
        setError(body.error || body.message || "重置密码失败");
      } catch {
        setError("重置密码失败");
      }
      return;
    }
    setMessage("密码已重置，请重新登录");
    setTimeout(() => navigate("/login", { replace: true }), 1200);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-5">
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle>重置密码</CardTitle>
          <CardDescription>设置新密码后，原有登录会话将失效。</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          {message && (
            <div className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {message}
            </div>
          )}
          <form onSubmit={submit} className="grid gap-4">
            <Input
              type="password"
              placeholder="新密码（至少 8 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
            <Input
              type="password"
              placeholder="确认新密码"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              required
            />
            <Button type="submit" disabled={!token || !!message}>
              重置密码
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
