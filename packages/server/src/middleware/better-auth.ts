import type { Database } from "@cos-tool-bot/database";
import { authMembers, authOrganizations } from "@cos-tool-bot/database";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppAuth } from "../auth.js";
import { AUTH_ORGANIZATION_SLUG } from "../auth.js";

export type AuthUser = AppAuth["$Infer"]["Session"]["user"];
export type AuthSession = AppAuth["$Infer"]["Session"]["session"];

export interface AuthMember {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
}

export interface AuthOrganization {
  id: string;
  name: string;
  slug: string;
}

export interface AuthVariables {
  authUser: AuthUser;
  authSession: AuthSession;
  authMember: AuthMember;
  authOrganization: AuthOrganization;
}

type AuthContext = Context<{ Variables: AuthVariables }>;
type Auth = AppAuth;

export function requireAuth(auth: Auth, db: Database): MiddlewareHandler {
  return async (c: AuthContext, next: Next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HTTPException(401, { message: "请先登录" });

    const [membership] = await db
      .select({
        memberId: authMembers.id,
        userId: authMembers.userId,
        organizationId: authMembers.organizationId,
        role: authMembers.role,
        organizationName: authOrganizations.name,
        organizationSlug: authOrganizations.slug,
      })
      .from(authMembers)
      .innerJoin(authOrganizations, eq(authMembers.organizationId, authOrganizations.id))
      .where(
        and(
          eq(authMembers.userId, session.user.id),
          eq(authOrganizations.slug, AUTH_ORGANIZATION_SLUG),
        ),
      )
      .limit(1);

    if (!membership) {
      throw new HTTPException(403, { message: "当前账号尚未加入工作区，请使用有效邀请链接加入" });
    }

    c.set("authUser", session.user);
    c.set("authSession", session.session);
    c.set("authMember", {
      id: membership.memberId,
      userId: membership.userId,
      organizationId: membership.organizationId,
      role: membership.role,
    });
    c.set("authOrganization", {
      id: membership.organizationId,
      name: membership.organizationName,
      slug: membership.organizationSlug,
    });
    await next();
  };
}

export const ownerOrAdmin = new Set(["owner", "admin"]);
export const ownerOnly = new Set(["owner"]);
const APP_WRITE_ROLES = new Set(["owner", "admin", "editor"]);

/**
 * Applies the first-version workspace permission policy to existing API routes:
 * viewers can read, editors can write operational resources, and sensitive
 * admin resources remain restricted to owner/admin.
 */
export function requireAppAccess(auth: Auth, db: Database): MiddlewareHandler {
  const authenticate = requireAuth(auth, db);
  return async (c: AuthContext, next: Next) => {
    await authenticate(c, async () => undefined);

    const role = c.get("authMember").role;
    const path = c.req.path;
    const method = c.req.method;
    const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const isSensitive =
      path.startsWith("/api/backup") ||
      path.startsWith("/api/mcp-servers") ||
      path.startsWith("/api/api-test");

    if (isSensitive && !ownerOrAdmin.has(role)) {
      throw new HTTPException(403, { message: "当前角色没有访问该功能的权限" });
    }
    if (!isRead && !APP_WRITE_ROLES.has(role)) {
      throw new HTTPException(403, { message: "当前角色没有修改权限" });
    }
    await next();
  };
}

/** Must run after `requireAuth`, which populates `authMember` on the context. */
export function requireRoles(roles: Set<string>): MiddlewareHandler {
  return async (c: AuthContext, next: Next) => {
    if (!roles.has(c.get("authMember").role)) {
      throw new HTTPException(403, { message: "当前角色没有权限执行该操作" });
    }
    await next();
  };
}
