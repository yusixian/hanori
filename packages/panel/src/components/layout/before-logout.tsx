import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";

export type LogoutAction = () => Promise<void>;
type BeforeLogoutGuard = (action: LogoutAction) => void;

type BeforeLogoutContextValue = {
  registerBeforeLogout: (guard: BeforeLogoutGuard) => () => void;
  requestLogout: (action: LogoutAction) => void;
};

const BeforeLogoutContext = createContext<BeforeLogoutContextValue | null>(null);

export function BeforeLogoutProvider({ children }: { children: ReactNode }) {
  const guardRef = useRef<BeforeLogoutGuard | null>(null);

  const registerBeforeLogout = useCallback((guard: BeforeLogoutGuard) => {
    guardRef.current = guard;
    return () => {
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, []);

  const requestLogout = useCallback((action: LogoutAction) => {
    const guard = guardRef.current;
    if (guard) {
      guard(action);
      return;
    }
    void action().catch(() => undefined);
  }, []);

  const value = useMemo(
    () => ({ registerBeforeLogout, requestLogout }),
    [registerBeforeLogout, requestLogout],
  );

  return <BeforeLogoutContext.Provider value={value}>{children}</BeforeLogoutContext.Provider>;
}

export function useBeforeLogout() {
  const context = useContext(BeforeLogoutContext);
  if (!context) throw new Error("useBeforeLogout must be used within BeforeLogoutProvider");
  return context;
}
