import type { AuthProvider } from "@refinedev/core";
import { authClient } from "@/lib/auth-client";
import { authFetch } from "@/lib/client";

export const authProvider: AuthProvider = {
  login: async ({ email, password }: { email: string; password: string }) => {
    const result = await authClient.signIn.email({ email, password });
    if (!("error" in result) || !result.error) {
      const membership = await authFetch("/api/authz/me");
      if (membership.ok) return { success: true, redirectTo: "/" };
      await authClient.signOut();
      return {
        success: false,
        error: new Error("该账号尚未加入工作区，请使用邀请链接注册"),
      };
    }

    return {
      success: false,
      error: new Error("error" in result && result.error ? result.error.message : "登录失败"),
    };
  },

  logout: async () => {
    await authClient.signOut();
    return { success: true, redirectTo: "/login" };
  },

  check: async () => {
    const result = await authClient.getSession();
    if (!("data" in result) || !result.data?.user) {
      return { authenticated: false, redirectTo: "/login" };
    }
    const membership = await authFetch("/api/authz/me");
    if (!membership.ok) {
      await authClient.signOut();
      return { authenticated: false, redirectTo: "/login" };
    }
    return { authenticated: true };
  },

  // 401s are handled by authFetch (hard redirect to /login); nothing extra to do here.
  onError: async (error) => {
    return { error };
  },
};
