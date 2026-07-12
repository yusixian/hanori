import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/client";
import { useEffect, useState, type FormEvent } from "react";

type Me = {
  user: { id: string; name: string; email: string };
  member: { id: string; role: string };
  organization: { id: string; name: string };
};

type Member = { id: string; userId: string; name: string; email: string; role: string };
type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string };

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error || body.message || "操作失败";
  } catch {
    return "操作失败";
  }
}

/** Best-effort clipboard copy; fails silently on non-secure contexts where the link is shown instead. */
async function tryCopy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [notice, setNotice] = useState("");
  const [generatedLink, setGeneratedLink] = useState("");
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");

  const load = async () => {
    const meResponse = await authFetch("/api/authz/me");
    if (!meResponse.ok) {
      setError(await readError(meResponse));
      return;
    }
    const meBody = (await meResponse.json()) as { data: Me };
    setMe(meBody.data);
    if (meBody.data.member.role !== "owner" && meBody.data.member.role !== "admin") return;

    const [membersResponse, invitationsResponse] = await Promise.all([
      authFetch("/api/authz/members"),
      authFetch("/api/authz/invitations"),
    ]);
    if (membersResponse.ok) {
      const body = (await membersResponse.json()) as { data: Member[] };
      setMembers(body.data);
    }
    if (invitationsResponse.ok) {
      const body = (await invitationsResponse.json()) as { data: Invitation[] };
      setInvitations(body.data);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setGeneratedLink("");
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    const response = await authFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setNotice("密码已修改，其他设备的登录已失效");
  };

  const createInvitation = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setGeneratedLink("");
    const response = await authFetch("/api/authz/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    const body = (await response.json()) as { data: { link: string } };
    setInviteEmail("");
    setGeneratedLink(body.data.link);
    const copied = await tryCopy(body.data.link);
    setNotice(copied ? "邀请链接已生成并复制到剪贴板" : "邀请链接已生成，请手动复制下方链接");
    await load();
  };

  const copyResetLink = async (memberId: string) => {
    setError("");
    setNotice("");
    setGeneratedLink("");
    const response = await authFetch(`/api/authz/members/${memberId}/reset-password`, {
      method: "POST",
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    const body = (await response.json()) as { data: { link: string } };
    setGeneratedLink(body.data.link);
    const copied = await tryCopy(body.data.link);
    setNotice(
      copied ? "密码重置链接已生成并复制到剪贴板" : "密码重置链接已生成，请手动复制下方链接",
    );
  };

  const changeRole = async (memberId: string, role: string) => {
    const response = await authFetch(`/api/authz/members/${memberId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) setError(await readError(response));
    else await load();
  };

  const cancelInvitation = async (id: string) => {
    const response = await authFetch(`/api/authz/invitations/${id}`, { method: "DELETE" });
    if (!response.ok) setError(await readError(response));
    else await load();
  };

  if (!me) {
    return error ? (
      <div className="py-10 text-sm text-red-700">{error}</div>
    ) : (
      <div className="text-muted-foreground py-10 text-sm">正在加载设置…</div>
    );
  }

  const canManageMembers = me.member.role === "owner" || me.member.role === "admin";
  const isOwner = me.member.role === "owner";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">管理账户、成员和工作区权限</p>
      </div>

      {(notice || error) && (
        <div
          className={
            error
              ? "rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
              : "rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
          }
        >
          <div>{error || notice}</div>
          {!error && generatedLink && (
            <code className="mt-2 block rounded bg-white/60 px-2 py-1 text-xs break-all select-all">
              {generatedLink}
            </code>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>
            {me.user.name} · {me.user.email} · {me.member.role}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="grid max-w-xl gap-4">
            <label className="space-y-2 text-sm font-medium">
              当前密码
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="space-y-2 text-sm font-medium">
              新密码
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <label className="space-y-2 text-sm font-medium">
              确认新密码
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <Button type="submit" className="w-fit">
              修改密码
            </Button>
          </form>
        </CardContent>
      </Card>

      {canManageMembers && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Invite member</CardTitle>
              <CardDescription>
                邀请链接有效期 48 小时，只能接受一次，并绑定指定邮箱。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={createInvitation}
                className="flex max-w-2xl flex-wrap items-end gap-3"
              >
                <label className="min-w-64 flex-1 space-y-2 text-sm font-medium">
                  邮箱
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="member@example.com"
                    required
                  />
                </label>
                <label className="space-y-2 text-sm font-medium">
                  角色
                  <select
                    className="border-input h-10 rounded-lg border bg-white px-3 text-sm"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                  >
                    {isOwner && <option value="admin">admin</option>}
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                </label>
                <Button type="submit">生成并复制链接</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y rounded-xl border">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div>
                      <div className="font-medium">{member.name}</div>
                      <div className="text-muted-foreground">{member.email}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {member.role === "owner" ? (
                        <span className="bg-accent rounded-md px-2 py-1 text-xs">owner</span>
                      ) : (
                        <select
                          className="border-input h-9 rounded-lg border bg-white px-2 text-xs"
                          value={member.role}
                          onChange={(e) => void changeRole(member.id, e.target.value)}
                        >
                          {isOwner && <option value="admin">admin</option>}
                          <option value="editor">editor</option>
                          <option value="viewer">viewer</option>
                        </select>
                      )}
                      {isOwner && member.userId !== me.user.id && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void copyResetLink(member.id)}
                        >
                          重置密码
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Invitations</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y rounded-xl border">
                {invitations
                  .filter((item) => item.status === "pending")
                  .map((invitation) => (
                    <div
                      key={invitation.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                    >
                      <span>
                        {invitation.email} · {invitation.role}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void cancelInvitation(invitation.id)}
                      >
                        撤销
                      </Button>
                    </div>
                  ))}
                {invitations.filter((item) => item.status === "pending").length === 0 && (
                  <div className="text-muted-foreground px-4 py-5 text-sm">暂无待处理邀请</div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {isOwner && (
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>{me.organization.name} · owner 可以管理完整成员权限。</CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
