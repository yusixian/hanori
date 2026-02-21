function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  BOT_TOKEN: required("BOT_TOKEN"),
  JWT_SECRET: required("JWT_SECRET"),
  PANEL_PASSWORD: required("PANEL_PASSWORD"),
  ADMIN_CHAT_IDS: JSON.parse(
    optional("ADMIN_CHAT_IDS", "[]"),
  ) as number[],
  PORT: Number(optional("PORT", "3000")),
} as const;
