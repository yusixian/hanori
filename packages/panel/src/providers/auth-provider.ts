import type { AuthProvider } from "@refinedev/core";
import { i18n } from "@/i18n";
import { authClient } from "@/lib/auth-client";
import { authFetch, loginPathFor } from "@/lib/client";

export const authProvider: AuthProvider = {
  login: async ({ email, password }: { email: string; password: string }) => {
    const result = await authClient.signIn.email({ email, password });
    if (!("error" in result) || !result.error) {
      const membership = await authFetch("/api/authz/me");
      if (membership.ok) return { success: true, redirectTo: "/" };
      await authClient.signOut();
      return {
        success: false,
        error: new Error(i18n.t("auth:errors.membershipRequired")),
      };
    }

    return {
      success: false,
      error: new Error(
        "error" in result && result.error
          ? result.error.message
          : i18n.t("auth:errors.loginFailed"),
      ),
    };
  },

  logout: async () => {
    await authClient.signOut();
    return { success: true, redirectTo: "/login" };
  },

  check: async () => {
    const result = await authClient.getSession();
    if (!("data" in result) || !result.data?.user) {
      return { authenticated: false, redirectTo: loginPathFor(window.location) };
    }
    const membership = await authFetch("/api/authz/me");
    if (!membership.ok) {
      await authClient.signOut();
      return { authenticated: false, redirectTo: loginPathFor(window.location) };
    }
    return { authenticated: true };
  },

  // 401s are handled by authFetch (hard redirect to /login); nothing extra to do here.
  onError: async (error) => {
    return { error };
  },
};
