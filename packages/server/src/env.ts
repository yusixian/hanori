function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isNaN(value) ? fallback : value;
}

const DEFAULT_ENCRYPTION_KEY = "c0s-t00l-b0t$2024!dEf@uLt#EnCrYpT10n-K3y";

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  BOT_TOKEN: optional("BOT_TOKEN"),
  JWT_SECRET: required("JWT_SECRET"),
  PANEL_PASSWORD: required("PANEL_PASSWORD"),
  ADMIN_CHAT_IDS: JSON.parse(optional("ADMIN_CHAT_IDS", "[]")) as number[],
  ENCRYPTION_KEY: optional("ENCRYPTION_KEY", DEFAULT_ENCRYPTION_KEY),
  USING_DEFAULT_ENCRYPTION_KEY: !process.env.ENCRYPTION_KEY,
  PORT: optionalInt("PORT", 3000),
  LOG_RETENTION_DAYS: optionalInt("LOG_RETENTION_DAYS", 30),
  LOG_RETENTION_DAYS_ERROR: optionalInt("LOG_RETENTION_DAYS_ERROR", 90),
  LOG_CLEANUP_INTERVAL_HOURS: optionalInt("LOG_CLEANUP_INTERVAL_HOURS", 24),
} as const;
