import { authFetch } from "@/lib/client";
import { useEffect, useState } from "react";

type MembershipResponse = {
  data?: { member?: { role?: string } };
};

/** Resolves to the panel membership role, or null until it is known. */
export function usePanelRole(): string | null {
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void authFetch("/api/authz/me", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as MembershipResponse;
        if (!controller.signal.aborted) setRole(body.data?.member?.role ?? null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return role;
}

/** Protected Bot settings stay hidden until the current membership is known to be privileged. */
export function useCanManageBot(): boolean {
  const role = usePanelRole();
  return role === "owner" || role === "admin";
}
