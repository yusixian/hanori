import { createAuthClient } from "better-auth/react";
import type { BetterAuthClientOptions } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

type ClientOptions = BetterAuthClientOptions & {
  plugins: [ReturnType<typeof organizationClient>];
};

export const authClient: ReturnType<typeof createAuthClient<ClientOptions>> = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  fetchOptions: { credentials: "include" },
  plugins: [organizationClient()],
});
