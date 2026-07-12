import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLogin } from "@refinedev/core";
import { Bot, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";

export function LoginPage() {
  const [password, setPassword] = useState("");
  const { mutate: login, isLoading } = useLogin();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    login({ password });
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-5">
      <div className="pointer-events-none absolute -top-32 left-1/2 size-[34rem] -translate-x-1/2 rounded-full bg-blue-200/40 blur-3xl" />
      <Card className="relative w-full max-w-[420px]">
        <CardHeader className="items-center px-7 pt-8 text-center">
          <div className="bg-primary mb-3 flex size-12 items-center justify-center rounded-2xl text-white shadow-lg shadow-blue-600/20">
            <Bot className="h-6 w-6" />
          </div>
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>登录 cos-tool-bot 管理面板</CardDescription>
        </CardHeader>
        <CardContent className="px-7 pb-8">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <label className="space-y-2">
              <span className="text-sm font-medium">访问密码</span>
              <div className="relative">
                <LockKeyhole className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2" />
                <Input
                  className="pl-10"
                  type="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
            </label>
            <Button type="submit" disabled={isLoading || !password}>
              {isLoading ? "正在登录…" : "登录"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
