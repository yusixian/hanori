import { request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Logs the throwaway acceptance owner in through the real Better Auth endpoint and
// stores the session cookie so authenticated specs can reuse it via storageState.
export default async function globalSetup() {
  const runDir = process.env.ACCEPTANCE_RUN_DIR ?? ".acceptance/runs/local";
  const baseURL = process.env.ACCEPTANCE_BASE_URL ?? "http://localhost:3100";
  const email = process.env.ACCEPTANCE_OWNER_EMAIL ?? "owner@acceptance.test";
  const password = process.env.ACCEPTANCE_OWNER_PASSWORD ?? "acceptance-password-123";

  mkdirSync(runDir, { recursive: true });
  const context = await request.newContext({ baseURL });
  const response = await context.post("/api/auth/sign-in/email", {
    data: { email, password },
  });
  if (!response.ok()) {
    throw new Error(`Acceptance login failed: ${response.status()} ${await response.text()}`);
  }
  await context.storageState({ path: join(runDir, "auth-state.json") });
  await context.dispose();
}
