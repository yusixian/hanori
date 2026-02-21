<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { api } from "../api/client";

const router = useRouter();
const auth = useAuthStore();

const botStatus = ref("stopped");
const botUptime = ref<number | null>(null);
const actionLoading = ref(false);

const uptimeText = computed(() => {
  if (botUptime.value === null) return "-";
  const seconds = Math.floor(botUptime.value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
});

const statusColor = computed(() => {
  switch (botStatus.value) {
    case "running":
      return "text-green-600 bg-green-100";
    case "stopped":
      return "text-red-600 bg-red-100";
    case "restarting":
      return "text-yellow-600 bg-yellow-100";
    default:
      return "text-gray-600 bg-gray-100";
  }
});

async function fetchStatus() {
  const res = await api.getBotStatus();
  if (res.ok && res.data) {
    botStatus.value = res.data.status;
    botUptime.value = res.data.uptime;
  }
}

async function handleAction(action: "start" | "stop" | "restart") {
  actionLoading.value = true;
  try {
    if (action === "start") await api.startBot();
    else if (action === "stop") await api.stopBot();
    else await api.restartBot();
    await fetchStatus();
  } finally {
    actionLoading.value = false;
  }
}

function handleLogout() {
  auth.logout();
  router.push("/login");
}

onMounted(() => {
  fetchStatus();
  const interval = setInterval(fetchStatus, 5000);
  return () => clearInterval(interval);
});
</script>

<template>
  <div class="mx-auto max-w-4xl p-6">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-800">Dashboard</h1>
      <div class="flex gap-2">
        <router-link
          to="/logs"
          class="rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300"
        >
          Logs
        </router-link>
        <button
          class="rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300"
          @click="handleLogout"
        >
          退出
        </button>
      </div>
    </div>

    <!-- Bot Status Card -->
    <div class="rounded-lg bg-white p-6 shadow-md">
      <h2 class="mb-4 text-lg font-semibold text-gray-700">Bot 状态</h2>
      <div class="flex items-center gap-4">
        <span
          class="rounded-full px-3 py-1 text-sm font-medium"
          :class="statusColor"
        >
          {{ botStatus }}
        </span>
        <span class="text-sm text-gray-500">
          运行时间: {{ uptimeText }}
        </span>
      </div>

      <div class="mt-4 flex gap-2">
        <button
          :disabled="actionLoading || botStatus === 'running'"
          class="rounded-md bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
          @click="handleAction('start')"
        >
          启动
        </button>
        <button
          :disabled="actionLoading || botStatus === 'stopped'"
          class="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          @click="handleAction('stop')"
        >
          停止
        </button>
        <button
          :disabled="actionLoading"
          class="rounded-md bg-yellow-600 px-4 py-2 text-sm text-white hover:bg-yellow-700 disabled:opacity-50"
          @click="handleAction('restart')"
        >
          重启
        </button>
      </div>
    </div>
  </div>
</template>
