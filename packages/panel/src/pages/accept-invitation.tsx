import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";

async function acceptInvitation(invitationId: string): Promise<string | null> {
  const response = await fetch("/api/auth/organization/accept-invitation", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitationId }),
  });
  if (response.ok) return null;
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message || body.error || "接受邀请失败";
  } catch {
    return "接受邀请失败";
  }
}

export function AcceptInvitationPage() {
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
      const message = await acceptInvitation(invitationId);
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
      setError(result.error.message || "注册失败");
      setLoading(false);
      return;
    }
    const message = await acceptInvitation(invitationId);
    if (message) setError(message);
    else navigate("/", { replace: true });
    setLoading(false);
  };

  const signIn = async () => {
    setError("");
    setLoading(true);
    const result = await authClient.signIn.email({ email, password });
    if ("error" in result && result.error) {
      setError(result.error.message || "登录失败");
      setLoading(false);
      return;
    }
    const message = await acceptInvitation(invitationId);
    if (message) setError(message);
    else navigate("/", { replace: true });
    setLoading(false);
  };

  if (!invitationId)
    return <div className="p-8 text-center text-sm text-red-600">邀请链接缺少参数</div>;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-5">
      <Card className="relative w-full max-w-[440px]">
        <CardHeader>
          <CardTitle>加入工作区</CardTitle>
          <CardDescription>请使用受邀邮箱注册或登录，然后接受邀请。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <form onSubmit={signUp} className="grid gap-3">
            <Input
              placeholder="姓名"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Input
              type="email"
              placeholder="受邀邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <Input
              type="password"
              placeholder="设置密码（至少 8 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
              required
            />
            <Button type="submit" disabled={loading}>
              注册并加入
            </Button>
          </form>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => void signIn()}
            disabled={loading || !email || !password}
          >
            已有账号，登录并加入
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
            使用 Google 登录并加入
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
