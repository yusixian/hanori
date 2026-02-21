<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { api } from "../api/client";
import type { LogEntry } from "@cos-tool-bot/shared";

const logs = ref<LogEntry[]>([]);
const page = ref(1);
const levelFilter = ref("");
const loading = ref(false);
let eventSource: EventSource | null = null;

const levelColors: Record<string, string> = {
  info: "text-blue-600 bg-blue-50",
  warn: "text-yellow-600 bg-yellow-50",
  error: "text-red-600 bg-red-50",
};

async function fetchLogs() {
  loading.value = true;
  try {
    const res = await api.getLogs(
      page.value,
      50,
      levelFilter.value || undefined,
    );
    if (res.ok && res.data) {
      logs.value = res.data as LogEntry[];
    }
  } finally {
    loading.value = false;
  }
}

function connectSSE() {
  const token = localStorage.getItem("token");
  eventSource = new EventSource(
    `/api/logs/stream?token=${token}`,
  );
  eventSource.addEventListener("log", (event: MessageEvent) => {
    const log = JSON.parse(event.data as string) as LogEntry;
    logs.value.unshift(log);
    if (logs.value.length > 200) {
      logs.value.pop();
    }
  });
}

onMounted(() => {
  fetchLogs();
  connectSSE();
});

onUnmounted(() => {
  eventSource?.close();
});
</script>

<template>
  <div class="mx-auto max-w-4xl p-6">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-800">Logs</h1>
      <div class="flex gap-2">
        <router-link
          to="/"
          class="rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300"
        >
          Dashboard
        </router-link>
      </div>
    </div>

    <!-- Filters -->
    <div class="mb-4 flex items-center gap-4">
      <select
        v-model="levelFilter"
        class="rounded-md border border-gray-300 px-3 py-2 text-sm"
        @change="fetchLogs"
      >
        <option value="">All Levels</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
      <button
        class="rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300"
        @click="fetchLogs"
      >
        刷新
      </button>
    </div>

    <!-- Log List -->
    <div class="rounded-lg bg-white shadow-md">
      <div v-if="loading" class="p-6 text-center text-gray-500">
        加载中...
      </div>
      <div v-else-if="logs.length === 0" class="p-6 text-center text-gray-500">
        暂无日志
      </div>
      <div v-else class="divide-y divide-gray-100">
        <div
          v-for="log in logs"
          :key="log.id"
          class="flex items-start gap-3 px-4 py-3"
        >
          <span
            class="mt-0.5 rounded px-2 py-0.5 text-xs font-medium"
            :class="levelColors[log.level] ?? 'text-gray-600 bg-gray-50'"
          >
            {{ log.level }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-gray-800">{{ log.message }}</p>
            <p class="mt-1 text-xs text-gray-400">
              {{ new Date(log.createdAt).toLocaleString("zh-CN") }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div class="mt-4 flex justify-center gap-2">
      <button
        :disabled="page <= 1"
        class="rounded-md bg-gray-200 px-3 py-1 text-sm disabled:opacity-50"
        @click="page--; fetchLogs()"
      >
        上一页
      </button>
      <span class="px-3 py-1 text-sm text-gray-600">第 {{ page }} 页</span>
      <button
        class="rounded-md bg-gray-200 px-3 py-1 text-sm"
        @click="page++; fetchLogs()"
      >
        下一页
      </button>
    </div>
  </div>
</template>
