import type { Database } from "@cos-tool-bot/database";
import { authInvitations, authMembers, authUsers } from "@cos-tool-bot/database";
import { zValidator } from "@hono/zod-validator";
import { getOrgAdapter } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { organizationOptions } from "../auth.js";
import type { AppAuth } from "../auth.js";
import {
  ownerOnly,
  ownerOrAdmin,
  requireAuth,
  requireRoles,
  type AuthVariables,
} from "../middleware/better-auth.js";

type Auth = AppAuth;

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "editor", "viewer"]),
});

const roleSchema = z.object({
  role: z.enum(["admin", "editor", "viewer", "owner"]),
});

const resetSchema = z.object({
  token: z.string().min(20),
  newPassword: z.string().min(8).max(128),
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function authzError(message: string, status: 400 | 403 | 404 = 400): never {
  throw new HTTPException(status, { message });
}

export function authzRoutes(auth: Auth, db: Database, baseURL: string) {
  return (
    new Hono<{ Variables: AuthVariables }>()
      // Owner-generated reset links are intentionally usable before login.
      .post("/reset-password", zValidator("json", resetSchema), async (c) => {
        const body = c.req.valid("json");
        const context = await auth.$context;
        const identifier = `password-reset:${hashToken(body.token)}`;
        const verification = await context.internalAdapter.consumeVerificationValue(identifier);
        if (!verification) authzError("密码重置链接无效或已过期", 400);

        const password = await context.password.hash(body.newPassword);
        const accounts = await context.internalAdapter.findAccounts(verification.value);
        if (accounts.some((account) => account.providerId === "credential")) {
          await context.internalAdapter.updatePassword(verification.value, password);
        } else {
          await context.internalAdapter.createAccount({
            userId: verification.value,
            providerId: "credential",
            accountId: verification.value,
            password,
          });
        }
        await context.internalAdapter.deleteUserSessions(verification.value);
        return c.json({ ok: true as const });
      })
      .use("*", requireAuth(auth, db))
      .get("/me", (c) => {
        const user = c.get("authUser");
        const member = c.get("authMember");
        const organization = c.get("authOrganization");
        return c.json({
          ok: true as const,
          data: {
            user,
            member: { id: member.id, role: member.role },
            organization,
          },
        });
      })
      .get("/members", requireRoles(ownerOrAdmin), async (c) => {
        const organizationId = c.get("authOrganization").id;
        const rows = await db
          .select({
            id: authMembers.id,
            userId: authMembers.userId,
            role: authMembers.role,
            createdAt: authMembers.createdAt,
            name: authUsers.name,
            email: authUsers.email,
            image: authUsers.image,
          })
          .from(authMembers)
          .innerJoin(authUsers, eq(authMembers.userId, authUsers.id))
          .where(eq(authMembers.organizationId, organizationId));
        return c.json({ ok: true as const, data: rows });
      })
      .get("/invitations", requireRoles(ownerOrAdmin), async (c) => {
        const rows = await db
          .select()
          .from(authInvitations)
          .where(eq(authInvitations.organizationId, c.get("authOrganization").id));
        return c.json({ ok: true as const, data: rows });
      })
      .post(
        "/invitations",
        requireRoles(ownerOrAdmin),
        zValidator("json", inviteSchema),
        async (c) => {
          const body = c.req.valid("json");
          const currentRole = c.get("authMember").role;
          if (currentRole === "admin" && body.role === "admin") {
            authzError("admin 只能邀请 editor 或 viewer", 403);
          }

          const email = body.email.toLowerCase();
          const organizationId = c.get("authOrganization").id;

          // Manual createInvitation bypasses the plugin's cancelPendingInvitationsOnReInvite, so dedupe here.
          await db
            .update(authInvitations)
            .set({ status: "canceled" })
            .where(
              and(
                eq(authInvitations.organizationId, organizationId),
                eq(authInvitations.email, email),
                eq(authInvitations.status, "pending"),
              ),
            );

          const context = await auth.$context;
          const orgAdapter = getOrgAdapter(
            context as unknown as Parameters<typeof getOrgAdapter>[0],
            organizationOptions,
          );
          const invitation = await orgAdapter.createInvitation({
            invitation: {
              email,
              role: body.role,
              organizationId,
              teamIds: [],
            },
            user: c.get("authUser"),
          });
          const link = new URL(`/accept-invitation?id=${invitation.id}`, baseURL).toString();
          return c.json({
            ok: true as const,
            data: { invitation, link },
          });
        },
      )
      .delete("/invitations/:id", requireRoles(ownerOrAdmin), async (c) => {
        const invitationId = c.req.param("id");
        const [invitation] = await db
          .select()
          .from(authInvitations)
          .where(
            and(
              eq(authInvitations.id, invitationId),
              eq(authInvitations.organizationId, c.get("authOrganization").id),
              eq(authInvitations.status, "pending"),
            ),
          )
          .limit(1);
        if (!invitation) authzError("邀请不存在或已失效", 404);
        await db
          .update(authInvitations)
          .set({ status: "canceled" })
          .where(eq(authInvitations.id, invitationId));
        return c.json({ ok: true as const });
      })
      .patch(
        "/members/:id/role",
        requireRoles(ownerOrAdmin),
        zValidator("json", roleSchema),
        async (c) => {
          const body = c.req.valid("json");
          const current = c.get("authMember");
          const targetId = c.req.param("id");
          const [target] = await db
            .select()
            .from(authMembers)
            .where(
              and(
                eq(authMembers.id, targetId),
                eq(authMembers.organizationId, current.organizationId),
              ),
            )
            .limit(1);
          if (!target) authzError("成员不存在", 404);
          if (current.role === "admin" && (body.role === "owner" || body.role === "admin")) {
            authzError("admin 不能授予 owner 或 admin 角色", 403);
          }
          // Only the owner-transfer path (owner sets body.role === "owner") may touch an owner.
          if (target.role === "owner" && !(current.role === "owner" && body.role === "owner")) {
            authzError("不能修改 owner 的角色", 403);
          }
          if (current.role === "admin" && target.role === "admin") {
            authzError("admin 不能修改 admin 的角色", 403);
          }
          if (target.userId === current.userId && body.role !== "owner") {
            authzError("不能移除自己的最高权限", 400);
          }

          await db.transaction(async (tx) => {
            if (body.role === "owner") {
              await tx
                .update(authMembers)
                .set({ role: "admin" })
                .where(
                  and(
                    eq(authMembers.organizationId, current.organizationId),
                    eq(authMembers.role, "owner"),
                  ),
                );
            }
            await tx
              .update(authMembers)
              .set({ role: body.role })
              .where(eq(authMembers.id, targetId));
          });
          return c.json({ ok: true as const });
        },
      )
      .delete("/members/:id", requireRoles(ownerOrAdmin), async (c) => {
        const current = c.get("authMember");
        const targetId = c.req.param("id");
        const [target] = await db
          .select()
          .from(authMembers)
          .where(
            and(
              eq(authMembers.id, targetId),
              eq(authMembers.organizationId, current.organizationId),
            ),
          )
          .limit(1);
        if (!target) authzError("成员不存在", 404);
        if (target.role === "owner") authzError("不能移除 owner", 403);
        if (current.role === "admin" && target.role === "admin")
          authzError("admin 不能移除 admin", 403);
        await db.delete(authMembers).where(eq(authMembers.id, targetId));
        const context = await auth.$context;
        await context.internalAdapter.deleteUserSessions(target.userId);
        return c.json({ ok: true as const });
      })
      .post("/members/:id/reset-password", requireRoles(ownerOnly), async (c) => {
        const targetId = c.req.param("id");
        const [target] = await db
          .select({ member: authMembers, user: authUsers })
          .from(authMembers)
          .innerJoin(authUsers, eq(authMembers.userId, authUsers.id))
          .where(
            and(
              eq(authMembers.id, targetId),
              eq(authMembers.organizationId, c.get("authOrganization").id),
            ),
          )
          .limit(1);
        if (!target) authzError("成员不存在", 404);
        if (target.member.userId === c.get("authMember").userId) {
          authzError("请使用账户设置中的改密码功能", 400);
        }

        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
        const context = await auth.$context;
        await context.internalAdapter.createVerificationValue({
          identifier: `password-reset:${hashToken(token)}`,
          value: target.member.userId,
          expiresAt,
        });
        return c.json({
          ok: true as const,
          data: { link: new URL(`/reset-password?token=${token}`, baseURL).toString(), expiresAt },
        });
      })
  );
}
