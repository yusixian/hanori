import type { AuthProvider } from "@refinedev/core";
import { client } from "@/lib/client";

export const authProvider: AuthProvider = {
  login: async ({ password }: { password: string }) => {
    const res = await client.api.auth.login.$post({ json: { password } });
    const data = await res.json();

    if (res.ok && "data" in data) {
      localStorage.setItem("token", data.data.token);
      return { success: true, redirectTo: "/" };
    }

    return {
      success: false,
      error: { name: "LoginError", message: "error" in data ? data.error : "登录失败" },
    };
  },

  logout: async () => {
    localStorage.removeItem("token");
    return { success: true, redirectTo: "/login" };
  },

  check: async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      return { authenticated: false, redirectTo: "/login" };
    }

    try {
      const payload = JSON.parse(atob(token.split(".")[1]!));
      if (payload.exp * 1000 < Date.now()) {
        localStorage.removeItem("token");
        return { authenticated: false, redirectTo: "/login" };
      }
      return { authenticated: true };
    } catch {
      localStorage.removeItem("token");
      return { authenticated: false, redirectTo: "/login" };
    }
  },

  onError: async (error) => {
    if (error?.statusCode === 401) {
      return { logout: true, redirectTo: "/login" };
    }
    return { error };
  },
};
