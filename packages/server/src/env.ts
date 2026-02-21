function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isNaN(value) ? fallback : value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  BOT_TOKEN: required("BOT_TOKEN"),
  JWT_SECRET: required("JWT_SECRET"),
  PANEL_PASSWORD: required("PANEL_PASSWORD"),
  ADMIN_CHAT_IDS: JSON.parse(optional("ADMIN_CHAT_IDS", "[]")) as number[],
  PORT: optionalInt("PORT", 3000),
  LOG_RETENTION_DAYS: optionalInt("LOG_RETENTION_DAYS", 30),
  LOG_RETENTION_DAYS_ERROR: optionalInt("LOG_RETENTION_DAYS_ERROR", 90),
  LOG_CLEANUP_INTERVAL_HOURS: optionalInt("LOG_CLEANUP_INTERVAL_HOURS", 24),
} as const;
