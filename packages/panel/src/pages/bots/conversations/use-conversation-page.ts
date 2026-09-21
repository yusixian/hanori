import { useCallback, useLayoutEffect, useRef, useState } from "react";

interface PageResult<T> {
  data: T[];
  total: number;
}

// Only a result for the current query may be rendered. A failed refresh keeps that
// result, but a different chat/page never inherits its rows or its empty state.
export function useConversationPage<T>(
  key: string | null,
  request: (signal: AbortSignal) => Promise<PageResult<T>>,
) {
  const [state, setState] = useState<{
    key: string | null;
    result: PageResult<T> | null;
    pending: boolean;
    failed: boolean;
  }>({ key: null, result: null, pending: false, failed: false });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const activeKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (key === null || activeKey.current !== key) return false;
    const token = ++generation.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const isCurrent = () => token === generation.current && activeKey.current === key;
    setState((previous) => ({
      key,
      result: previous.key === key ? previous.result : null,
      pending: true,
      failed: false,
    }));
    try {
      const result = await request(nextController.signal);
      if (!isCurrent()) return false;
      setState({ key, result, pending: false, failed: false });
      return true;
    } catch {
      if (isCurrent()) setState((previous) => ({ ...previous, pending: false, failed: true }));
      return false;
    }
  }, [key, request]);

  useLayoutEffect(() => {
    activeKey.current = key;
    if (key !== null) void refresh();
    return () => {
      activeKey.current = null;
      generation.current += 1;
      controller.current?.abort();
    };
  }, [key, refresh]);

  const current = key !== null && state.key === key;
  return {
    result: current ? state.result : null,
    loading: key !== null && (!current || state.pending),
    failed: current && state.failed,
    refresh,
  };
}
