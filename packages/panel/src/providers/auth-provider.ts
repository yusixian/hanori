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
    const result = await authClient.signOut();
    if (result.error) {
      // Refine treats resolved failures as success and rechecks auth, which unmounts dirty forms.
      throw new Error(result.error.message || i18n.t("auth:errors.operationFailed"));
    }
    return { success: true, redirectTo: "/login" };
  },

  check: async () => {
    // The protected endpoint validates both the session and workspace membership.
    // A separate client-side session check can lag behind a successful sign-in.
    const membership = await fetch("/api/authz/me", { credentials: "include" });
    if (!membership.ok) {
      if (membership.status !== 401) await authClient.signOut();
      return { authenticated: false, redirectTo: loginPathFor(window.location) };
    }
    return { authenticated: true };
  },

  // Other API 401s are handled by authFetch (hard redirect to /login).
  onError: async (error) => {
    return { error };
  },
};
