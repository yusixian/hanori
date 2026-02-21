import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, setToken, clearToken } from "../api/client.js";

export const useAuthStore = defineStore("auth", () => {
  const token = ref(localStorage.getItem("token") ?? "");

  const isAuthenticated = computed(() => !!token.value);

  async function login(password: string) {
    const res = await api.login(password);
    if (res.ok && res.data) {
      token.value = res.data.token;
      setToken(res.data.token);
    } else {
      throw new Error(res.error ?? "登录失败");
    }
  }

  function logout() {
    token.value = "";
    clearToken();
  }

  return { token, isAuthenticated, login, logout };
});
