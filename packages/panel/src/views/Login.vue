<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();
const password = ref("");
const error = ref("");
const loading = ref(false);

async function handleLogin() {
  error.value = "";
  loading.value = true;
  try {
    await auth.login(password.value);
    router.push("/");
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "登录失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center">
    <div class="w-full max-w-sm rounded-lg bg-white p-8 shadow-md">
      <h1 class="mb-6 text-center text-2xl font-bold text-gray-800">
        cos-tool-bot
      </h1>
      <form @submit.prevent="handleLogin">
        <div class="mb-4">
          <label
            for="password"
            class="mb-2 block text-sm font-medium text-gray-700"
          >
            密码
          </label>
          <input
            id="password"
            v-model="password"
            type="password"
            class="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="输入面板密码"
            required
          />
        </div>
        <p v-if="error" class="mb-4 text-sm text-red-500">{{ error }}</p>
        <button
          type="submit"
          :disabled="loading"
          class="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {{ loading ? "登录中..." : "登录" }}
        </button>
      </form>
    </div>
  </div>
</template>
