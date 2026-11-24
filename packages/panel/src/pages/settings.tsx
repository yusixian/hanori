import "./settings.css";
import { AsrSettingsPanel } from "./asr-settings-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/client";
import {
  Activity,
  ArrowUpRight,
  Check,
  CheckCheck,
  KeyRound,
  Loader2,
  Mail,
  ShieldCheck,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import sakura from "../../../docs/public/docs/brand/hanori-sakura-v1.webp";

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

function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="settings-section" aria-labelledby={`${id}-title`}>
      <header className="settings-section-heading">
        <span className="settings-section-icon" aria-hidden="true">
          <Icon size={19} strokeWidth={1.5} />
        </span>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </header>
      <Card className="settings-surface">
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
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
  const [passwordPending, setPasswordPending] = useState(false);
  const [invitePending, setInvitePending] = useState(false);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

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
      confirmPasswordRef.current?.focus();
      return;
    }
    setPasswordPending(true);
    try {
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
    } catch {
      setError(t("errors.operationFailed"));
    } finally {
      setPasswordPending(false);
    }
  };

  const createInvitation = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setGeneratedLink("");
    setInvitePending(true);
    try {
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
      setNotice(
        copied ? t("settings.invitationLinkCopied") : t("settings.invitationLinkGenerated"),
      );
      await load();
    } catch {
      setError(t("errors.operationFailed"));
    } finally {
      setInvitePending(false);
    }
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
      <div role="alert" className="settings-load-error">
        <ShieldCheck aria-hidden="true" size={20} />
        {error}
      </div>
    ) : (
      <div role="status" className="settings-loading">
        <span className="settings-loading-dot" aria-hidden="true" />
        {t("settings.loading")}
      </div>
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

  const organizationName =
    me.organization.name === "cos-tool-bot" ? t("common:app.name") : me.organization.name;
  const pendingInvitations = invitations.filter((item) => item.status === "pending");
  const passwordMismatch = error === t("errors.passwordMismatch");

  return (
    <div className="settings-page">
      <header className="settings-heading">
        <div className="settings-heading-copy">
          <p className="settings-eyebrow">{t("settings.eyebrow")}</p>
          <h1>{t("settings.title")}</h1>
          <p className="settings-introduction">{t("settings.description")}</p>
        </div>
        <div className="settings-heading-art" aria-hidden="true">
          <img src={sakura} alt="" width={1536} height={1024} />
        </div>
      </header>

      <div className="settings-layout">
        <aside className="settings-rail" aria-label={t("settings.accountTitle")}>
          <div className="settings-profile">
            <div className="settings-avatar" aria-hidden="true">
              {me.user.name.trim().slice(0, 1).toUpperCase() || <Users size={22} />}
            </div>
            <h2>{me.user.name}</h2>
            <p className="settings-email">{me.user.email}</p>
            <span className="settings-role">
              <span aria-hidden="true" />
              {getRoleLabel(me.member.role)}
            </span>
            <div className="settings-profile-workspace">
              <p>{t("settings.workspaceLabel")}</p>
              <strong>{organizationName}</strong>
            </div>
          </div>
          <nav className="settings-jump-links" aria-label={t("settings.sectionNavigation")}>
            {canManageMembers && (
              <a href="/settings/diagnostics">
                <Activity size={16} aria-hidden="true" />
                {t("diagnostics.title")}
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            )}
            {canManageMembers && (
              <a href="#asr-settings">
                <ShieldCheck size={16} aria-hidden="true" />
                {t("asr.title")}
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            )}
            <a href="#account-security">
              <KeyRound size={16} aria-hidden="true" />
              {t("settings.securityTitle")}
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            {canManageMembers && (
              <a href="#workspace-members">
                <Users size={16} aria-hidden="true" />
                {t("settings.teamTitle")}
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            )}
            {isOwner && (
              <a href="#workspace-details">
                <ShieldCheck size={16} aria-hidden="true" />
                {t("settings.workspaceLabel")}
                <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            )}
          </nav>
        </aside>

        <div className="settings-body">
          {error && (
            <div
              role="alert"
              id="settings-error"
              className="settings-feedback settings-feedback-error"
            >
              {error}
            </div>
          )}
          <div
            role="status"
            className={notice && !error ? "settings-feedback settings-feedback-success" : undefined}
          >
            {!error && notice && (
              <>
                <Check size={18} aria-hidden="true" />
                <div>
                  {notice}
                  {generatedLink && (
                    <code className="settings-generated-link">{generatedLink}</code>
                  )}
                </div>
              </>
            )}
          </div>

          <SettingsSection
            id="account-security"
            icon={KeyRound}
            title={t("settings.securityTitle")}
            description={t("settings.securityDescription")}
          >
            <form onSubmit={changePassword} className="settings-password-form">
              <label className="settings-field settings-field-full">
                <span>{t("settings.currentPassword")}</span>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <label className="settings-field">
                <span>{t("settings.newPassword")}</span>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
              <label className="settings-field">
                <span>{t("settings.confirmNewPassword")}</span>
                <Input
                  ref={confirmPasswordRef}
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                  aria-invalid={passwordMismatch || undefined}
                  aria-describedby={passwordMismatch ? "settings-error" : undefined}
                />
              </label>
              <div className="settings-form-footer">
                <span>
                  <ShieldCheck size={15} aria-hidden="true" />
                  {t("settings.passwordHint")}
                </span>
                <Button type="submit" disabled={passwordPending} aria-busy={passwordPending}>
                  {passwordPending && (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  )}
                  {t("settings.changePassword")}
                </Button>
              </div>
            </form>
          </SettingsSection>

          {canManageMembers && <AsrSettingsPanel />}
          {canManageMembers && (
            <SettingsSection
              id="workspace-members"
              icon={Users}
              title={t("settings.teamTitle")}
              description={t("settings.teamDescription")}
            >
              <div className="settings-list-heading">
                <h3>{t("settings.membersTitle")}</h3>
                <span className="settings-count">{members.length}</span>
              </div>
              <div className="settings-members">
                {members.map((member) => (
                  <div key={member.id} className="settings-member">
                    <span className="settings-member-avatar" aria-hidden="true">
                      {member.name.trim().slice(0, 1).toUpperCase() || <Users size={16} />}
                    </span>
                    <div className="settings-member-identity">
                      <strong>{member.name}</strong>
                      <span>{member.email}</span>
                    </div>
                    <div className="settings-member-actions">
                      {member.role === "owner" ? (
                        <span className="settings-role">{t("roles.owner")}</span>
                      ) : (
                        <Select
                          className="settings-role-select"
                          value={member.role}
                          onChange={(e) => void changeRole(member.id, e.target.value)}
                          aria-label={t("settings.memberRole", { name: member.name })}
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
                          variant="ghost"
                          className="settings-reset-button"
                          onClick={() => void copyResetLink(member.id)}
                        >
                          <KeyRound size={14} aria-hidden="true" />
                          {t("settings.resetPassword")}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-invite-block">
                <div className="settings-list-heading">
                  <h3>
                    <UserPlus size={17} aria-hidden="true" />
                    {t("settings.inviteTitle")}
                  </h3>
                </div>
                <p>{t("settings.inviteDescription")}</p>
                <form onSubmit={createInvitation} className="settings-invite-form">
                  <label className="settings-field">
                    <span>{t("settings.emailLabel")}</span>
                    <Input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder={t("settings.emailPlaceholder")}
                      required
                    />
                  </label>
                  <label className="settings-field">
                    <span>{t("settings.roleLabel")}</span>
                    <Select
                      className="settings-invite-role"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      aria-label={t("settings.roleLabel")}
                    >
                      {isOwner && <option value="admin">{t("roles.admin")}</option>}
                      <option value="editor">{t("roles.editor")}</option>
                      <option value="viewer">{t("roles.viewer")}</option>
                    </Select>
                  </label>
                  <Button type="submit" disabled={invitePending} aria-busy={invitePending}>
                    {invitePending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <ArrowUpRight size={16} aria-hidden="true" />
                    )}
                    {t("settings.generateAndCopyLink")}
                  </Button>
                </form>
              </div>

              <div className="settings-invitations">
                <div className="settings-list-heading">
                  <h3>{t("settings.invitationsTitle")}</h3>
                  <span className="settings-count">{pendingInvitations.length}</span>
                </div>
                {pendingInvitations.map((invitation) => (
                  <div key={invitation.id} className="settings-invitation">
                    <Mail size={17} aria-hidden="true" />
                    <div>
                      <strong>{invitation.email}</strong>
                      <span>{getRoleLabel(invitation.role)}</span>
                    </div>
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
                {pendingInvitations.length === 0 && (
                  <div className="settings-invitation-empty">
                    <CheckCheck size={18} aria-hidden="true" />
                    <span>{t("settings.noPendingInvitations")}</span>
                  </div>
                )}
              </div>
            </SettingsSection>
          )}

          {isOwner && (
            <SettingsSection
              id="workspace-details"
              icon={ShieldCheck}
              title={t("settings.organizationTitle")}
            >
              <div className="settings-organization">
                <div>
                  <h3>{organizationName}</h3>
                  <p>{t("settings.ownerDescription", { name: organizationName })}</p>
                </div>
                <span className="settings-role">{t("roles.owner")}</span>
              </div>
            </SettingsSection>
          )}
        </div>
      </div>
    </div>
  );
}
