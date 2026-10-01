import type { Database } from "@cos-tool-bot/database";
import {
  authAccounts,
  authInvitations,
  authMembers,
  authOrganizations,
  authSessions,
  authUsers,
  authVerifications,
} from "@cos-tool-bot/database";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { createAccessControl, getOrgAdapter, organization } from "better-auth/plugins";
import type { Auth } from "better-auth";
import { and, eq, gt } from "drizzle-orm";
import { PRODUCT_NAME } from "@cos-tool-bot/shared";

export const AUTH_ORGANIZATION_SLUG = "cos-tool-bot";

/** Origins allowed for CORS and Better Auth trusted origins; dev also permits the Vite server. */
export function resolveAllowedOrigins(baseURL: string): string[] {
  return baseURL.startsWith("https://")
    ? [baseURL]
    : [baseURL, `http://localhost:${process.env.COS_TOOL_BOT_DEV_PANEL_PORT ?? 43101}`];
}

const ac = createAccessControl({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
} as const);

const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
});

const admin = ac.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["read"],
});

const editor = ac.newRole({});
const viewer = ac.newRole({});

export const organizationOptions = {
  allowUserToCreateOrganization: false,
  creatorRole: "owner",
  invitationExpiresIn: 60 * 60 * 48,
  cancelPendingInvitationsOnReInvite: true,
  ac,
  roles: { owner, admin, editor, viewer },
} as const;

export interface AuthConfig {
  baseURL: string;
  secret: string;
  ownerEmail: string;
  googleClientId?: string;
  googleClientSecret?: string;
}

export type AppAuth = Auth;

export function createAuth(db: Database, config: AuthConfig): AppAuth {
  const socialProviders =
    config.googleClientId && config.googleClientSecret
      ? {
          google: {
            clientId: config.googleClientId,
            clientSecret: config.googleClientSecret,
          },
        }
      : undefined;

  return betterAuth({
    appName: PRODUCT_NAME,
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: resolveAllowedOrigins(config.baseURL),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        organization: authOrganizations,
        member: authMembers,
        invitation: authInvitations,
      },
    }),
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = user.email.toLowerCase();
            if (email === config.ownerEmail.trim().toLowerCase()) return;
            const [invitation] = await db
              .select({ id: authInvitations.id })
              .from(authInvitations)
              .where(
                and(
                  eq(authInvitations.email, email),
                  eq(authInvitations.status, "pending"),
                  gt(authInvitations.expiresAt, new Date()),
                ),
              )
              .limit(1);
            return Boolean(invitation);
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    socialProviders,
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    plugins: [organization(organizationOptions)],
    advanced: {
      useSecureCookies: config.baseURL.startsWith("https://"),
    },
    // better-auth/minimal's inferred return type does not structurally match the full `Auth` type.
  }) as unknown as AppAuth;
}

export async function ensureAuthBootstrap(
  auth: AppAuth,
  ownerEmail: string,
  initialPassword: string,
) {
  const context = await auth.$context;
  const email = ownerEmail.trim().toLowerCase();
  const now = new Date();
  let userRecord = await context.internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });

  let user = userRecord?.user;
  if (!user) {
    if (!initialPassword) {
      throw new Error(
        "AUTH_OWNER_EMAIL is configured but PANEL_PASSWORD is missing for initial auth bootstrap",
      );
    }
    user = await context.internalAdapter.createUser({
      id: context.generateId({ model: "user" }) || crypto.randomUUID(),
      name: email.split("@")[0] || "Owner",
      email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    const password = await context.password.hash(initialPassword);
    await context.internalAdapter.createAccount({
      id: context.generateId({ model: "account" }) || crypto.randomUUID(),
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password,
      createdAt: now,
      updatedAt: now,
    });
  } else if (!(userRecord?.accounts ?? []).some((account) => account.providerId === "credential")) {
    if (!initialPassword) {
      throw new Error(
        "Existing owner has no password account; set PANEL_PASSWORD once to complete auth bootstrap",
      );
    }
    const password = await context.password.hash(initialPassword);
    await context.internalAdapter.createAccount({
      id: context.generateId({ model: "account" }) || crypto.randomUUID(),
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password,
      createdAt: now,
      updatedAt: now,
    });
  }

  const orgAdapter = getOrgAdapter(
    context as unknown as Parameters<typeof getOrgAdapter>[0],
    organizationOptions,
  );
  let organizationRecord = await orgAdapter.findOrganizationBySlug(AUTH_ORGANIZATION_SLUG);
  if (!organizationRecord) {
    organizationRecord = await orgAdapter.createOrganization({
      organization: {
        id: context.generateId({ model: "organization" }) || crypto.randomUUID(),
        name: PRODUCT_NAME,
        slug: AUTH_ORGANIZATION_SLUG,
        createdAt: now,
      },
    });
  }

  const member = await orgAdapter.findMemberByOrgId({
    userId: user.id,
    organizationId: organizationRecord.id,
  });
  if (!member) {
    await orgAdapter.createMember({
      id: context.generateId({ model: "member" }) || crypto.randomUUID(),
      organizationId: organizationRecord.id,
      userId: user.id,
      role: "owner",
      createdAt: now,
    });
  } else if (member.role !== "owner") {
    await orgAdapter.updateMember(member.id, "owner");
  }
}
