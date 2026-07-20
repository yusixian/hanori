function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

const DEFAULT_ENCRYPTION_KEY = "c0s-t00l-b0t$2024!dEf@uLt#EnCrYpT10n-K3y";

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  BOT_TOKEN: optional("BOT_TOKEN"),
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL:
    process.env.NODE_ENV === "production"
      ? required("BETTER_AUTH_URL")
      : optional("BETTER_AUTH_URL", `http://localhost:${optionalInt("PORT", 3000)}`),
  AUTH_OWNER_EMAIL: required("AUTH_OWNER_EMAIL"),
  GOOGLE_CLIENT_ID: optional("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: optional("GOOGLE_CLIENT_SECRET"),
  // Used only once to bootstrap the first owner during migration.
  PANEL_PASSWORD: optional("PANEL_PASSWORD"),
  ADMIN_CHAT_IDS: JSON.parse(optional("ADMIN_CHAT_IDS", "[]")) as number[],
  ENCRYPTION_KEY: optional("ENCRYPTION_KEY", DEFAULT_ENCRYPTION_KEY),
  USING_DEFAULT_ENCRYPTION_KEY: !process.env.ENCRYPTION_KEY,
  PORT: optionalInt("PORT", 3000),
  LOG_RETENTION_DAYS: optionalInt("LOG_RETENTION_DAYS", 30),
  LOG_RETENTION_DAYS_ERROR: optionalInt("LOG_RETENTION_DAYS_ERROR", 90),
  LOG_CLEANUP_INTERVAL_HOURS: optionalInt("LOG_CLEANUP_INTERVAL_HOURS", 24),
  BACKUP_DIR: optional("BACKUP_DIR", "./backups"),
  GENERATION_RETENTION_DAYS: optionalInt("GENERATION_RETENTION_DAYS", 30),
  NSFW_API_URL: optional("NSFW_API_URL"),
  CODING_WORKER_URL: optional("CODING_WORKER_URL"),
  CODING_WORKER_SOCKET: optional("CODING_WORKER_SOCKET"),
  CODING_WORKER_SECRET: optional("CODING_WORKER_SECRET"),
  CODING_JOB_DIR: optional("CODING_JOB_DIR", "./data/coding-job"),
  CODING_WORKSPACES_DIR: optional("CODING_WORKSPACES_DIR", "./data/code-workspaces"),
  CODING_GIT_DIR: optional("CODING_GIT_DIR", "./data/code-git"),
  CODING_WORKSPACE_UID: optionalInt("CODING_WORKSPACE_UID", process.getuid?.() ?? 1000),
  CODING_WORKSPACE_GID: optionalInt("CODING_WORKSPACE_GID", process.getgid?.() ?? 1000),
} as const;
