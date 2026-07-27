export const MINI_APP_ROLES = ["admin", "operator", "viewer", "none"] as const;

export type MiniAppRole = (typeof MINI_APP_ROLES)[number];

export const MINI_APP_CAPABILITIES = [
  "bot.lifecycle.manage",
  "bot.settings.read",
  "bot.settings.write",
  "chat.directory.read",
  "group.config.read",
  "group.config.write",
  "chat.ai-selection.read",
  "chat.ai-selection.write",
  "access.manage",
  "audit.read",
  "credentials.manage",
  "data.export",
  "data.delete",
] as const;

export type MiniAppCapability = (typeof MINI_APP_CAPABILITIES)[number];

const ADMIN_CAPABILITIES = Object.freeze([
  "bot.lifecycle.manage",
  "bot.settings.read",
  "bot.settings.write",
  "chat.directory.read",
  "group.config.read",
  "group.config.write",
  "chat.ai-selection.read",
  "chat.ai-selection.write",
  "access.manage",
  "audit.read",
] satisfies MiniAppCapability[]);

const OPERATOR_CAPABILITIES = Object.freeze([
  "chat.directory.read",
  "group.config.read",
  "group.config.write",
  "chat.ai-selection.read",
] satisfies MiniAppCapability[]);

const VIEWER_CAPABILITIES = Object.freeze([
  "chat.directory.read",
  "group.config.read",
  "chat.ai-selection.read",
] satisfies MiniAppCapability[]);

const NO_CAPABILITIES = Object.freeze([] satisfies MiniAppCapability[]);

/**
 * The sole M1 role-to-capability mapping. Reserved capabilities intentionally
 * remain unmapped so new routes deny access until the policy is updated.
 */
export const MINI_APP_ROLE_CAPABILITIES = Object.freeze({
  admin: ADMIN_CAPABILITIES,
  operator: OPERATOR_CAPABILITIES,
  viewer: VIEWER_CAPABILITIES,
  none: NO_CAPABILITIES,
}) satisfies Readonly<Record<MiniAppRole, readonly MiniAppCapability[]>>;

export function getMiniAppCapabilities(role: MiniAppRole): readonly MiniAppCapability[] {
  return MINI_APP_ROLE_CAPABILITIES[role];
}

export function hasMiniAppCapability(role: MiniAppRole, capability: string): boolean {
  return MINI_APP_ROLE_CAPABILITIES[role].some((candidate) => candidate === capability);
}
