import { authFetch } from "@/lib/client";
import { useEffect, useState } from "react";

type MembershipResponse = {
  data?: { member?: { role?: string } };
};

/** Protected Bot settings stay hidden until the current membership is known to be privileged. */
export function useCanManageBot(): boolean {
  const [canManage, setCanManage] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void authFetch("/api/authz/me", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as MembershipResponse;
        const role = body.data?.member?.role;
        if (!controller.signal.aborted) setCanManage(role === "owner" || role === "admin");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return canManage;
}
