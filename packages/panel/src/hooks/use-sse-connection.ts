import { authFetch } from "@/lib/client";
import type { LogEntry } from "@cos-tool-bot/shared";
import { useCallback, useEffect, useRef, useState } from "react";

const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30_000;

export function useSSEConnection(url: string) {
  const [connected, setConnected] = useState(false);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(INITIAL_RETRY_DELAY);

  const connect = useCallback(() => {
    abortRef.current?.abort();
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    const controller = new AbortController();
    abortRef.current = controller;

    const scheduleReconnect = () => {
      if (controller.signal.aborted) return;
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_DELAY);
      retryTimeoutRef.current = setTimeout(connect, delay);
    };

    authFetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        setConnected(true);
        retryDelayRef.current = INITIAL_RETRY_DELAY;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              try {
                const entry = JSON.parse(line.slice(5).trim()) as LogEntry;
                setLiveLogs((prev) => [entry, ...prev].slice(0, 20));
              } catch {
                /* ignore parse errors */
              }
            }
          }
        }
      })
      .catch(() => {
        /* aborted or network error */
      })
      .finally(() => {
        setConnected(false);
        scheduleReconnect();
      });
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      abortRef.current?.abort();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [connect]);

  const clearLiveLogs = useCallback(() => setLiveLogs([]), []);

  return { connected, liveLogs, clearLiveLogs };
}
