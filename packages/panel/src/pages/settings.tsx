import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/client";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

type Me = {
  user: { id: string; name: string; email: string };
  member: { id: string; role: string };
  organization: { id: string; name: string };
};

type Member = { id: string; userId: string; name: string; email: string; role: string };
type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string };

async function readError(response: Response, fallbackMessage: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error || body.message || fallbackMessage;
  } catch {
    return fallbackMessage;
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
  const { t } = useTranslation("auth");
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
      setError(await readError(meResponse, t("errors.operationFailed")));
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
      setError(t("errors.passwordMismatch"));
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
      setError(await readError(response, t("errors.operationFailed")));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setNotice(t("settings.passwordChanged"));
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
      setError(await readError(response, t("errors.operationFailed")));
      return;
    }
    const body = (await response.json()) as { data: { link: string } };
    setInviteEmail("");
    setGeneratedLink(body.data.link);
    const copied = await tryCopy(body.data.link);
    setNotice(copied ? t("settings.invitationLinkCopied") : t("settings.invitationLinkGenerated"));
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
      setError(await readError(response, t("errors.operationFailed")));
      return;
    }
    const body = (await response.json()) as { data: { link: string } };
    setGeneratedLink(body.data.link);
    const copied = await tryCopy(body.data.link);
    setNotice(copied ? t("settings.resetLinkCopied") : t("settings.resetLinkGenerated"));
  };

  const changeRole = async (memberId: string, role: string) => {
    const response = await authFetch(`/api/authz/members/${memberId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) setError(await readError(response, t("errors.operationFailed")));
    else await load();
  };

  const cancelInvitation = async (id: string) => {
    const response = await authFetch(`/api/authz/invitations/${id}`, { method: "DELETE" });
    if (!response.ok) setError(await readError(response, t("errors.operationFailed")));
    else await load();
  };

  if (!me) {
    return error ? (
      <div className="py-10 text-sm text-red-700">{error}</div>
    ) : (
      <div className="text-muted-foreground py-10 text-sm">{t("settings.loading")}</div>
    );
  }

  const canManageMembers = me.member.role === "owner" || me.member.role === "admin";
  const isOwner = me.member.role === "owner";
  const roleLabels: Record<string, string> = {
    owner: t("roles.owner"),
    admin: t("roles.admin"),
    editor: t("roles.editor"),
    viewer: t("roles.viewer"),
  };
  const getRoleLabel = (role: string) => roleLabels[role] ?? role;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("settings.description")}</p>
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
          <CardTitle>{t("settings.accountTitle")}</CardTitle>
          <CardDescription>
            {me.user.name} · {me.user.email} · {getRoleLabel(me.member.role)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={changePassword} className="grid max-w-xl gap-4">
            <label className="space-y-2 text-sm font-medium">
              {t("settings.currentPassword")}
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="space-y-2 text-sm font-medium">
              {t("settings.newPassword")}
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
              {t("settings.confirmNewPassword")}
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
              {t("settings.changePassword")}
            </Button>
          </form>
        </CardContent>
      </Card>

      {canManageMembers && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.inviteTitle")}</CardTitle>
              <CardDescription>{t("settings.inviteDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={createInvitation}
                className="flex max-w-2xl flex-wrap items-end gap-3"
              >
                <label className="min-w-64 flex-1 space-y-2 text-sm font-medium">
                  {t("settings.emailLabel")}
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder={t("settings.emailPlaceholder")}
                    required
                  />
                </label>
                <label className="space-y-2 text-sm font-medium">
                  {t("settings.roleLabel")}
                  <Select
                    className="border-input h-10 rounded-lg border bg-white px-3 text-sm"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                  >
                    {isOwner && <option value="admin">{t("roles.admin")}</option>}
                    <option value="editor">{t("roles.editor")}</option>
                    <option value="viewer">{t("roles.viewer")}</option>
                  </Select>
                </label>
                <Button type="submit">{t("settings.generateAndCopyLink")}</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("settings.membersTitle")}</CardTitle>
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
                        <span className="bg-accent rounded-md px-2 py-1 text-xs">
                          {t("roles.owner")}
                        </span>
                      ) : (
                        <Select
                          className="border-input h-9 rounded-lg border bg-white px-2 text-xs"
                          value={member.role}
                          onChange={(e) => void changeRole(member.id, e.target.value)}
                        >
                          {isOwner && <option value="admin">{t("roles.admin")}</option>}
                          <option value="editor">{t("roles.editor")}</option>
                          <option value="viewer">{t("roles.viewer")}</option>
                        </Select>
                      )}
                      {isOwner && member.userId !== me.user.id && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void copyResetLink(member.id)}
                        >
                          {t("settings.resetPassword")}
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
              <CardTitle>{t("settings.invitationsTitle")}</CardTitle>
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
                        {invitation.email} · {getRoleLabel(invitation.role)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void cancelInvitation(invitation.id)}
                      >
                        {t("settings.revoke")}
                      </Button>
                    </div>
                  ))}
                {invitations.filter((item) => item.status === "pending").length === 0 && (
                  <div className="text-muted-foreground px-4 py-5 text-sm">
                    {t("settings.noPendingInvitations")}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {isOwner && (
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.organizationTitle")}</CardTitle>
            <CardDescription>
              {t("settings.ownerDescription", { name: me.organization.name })}
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
