import { authFetch } from "@/lib/client";
import type { LogEntry } from "@cos-tool-bot/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export function useSSEConnection(url: string) {
  const [connected, setConnected] = useState(false);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const connect = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    authFetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        setConnected(true);

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
      .finally(() => setConnected(false));
  }, [url]);

  useEffect(() => {
    connect();
    return () => abortRef.current?.abort();
  }, [connect]);

  const clearLiveLogs = useCallback(() => setLiveLogs([]), []);

  return { connected, liveLogs, clearLiveLogs };
}
