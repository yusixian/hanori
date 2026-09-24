import { HarnessAdminScreen } from "@/components/harness/harness-admin-screen";
import { createPanelHarnessAdminApi } from "@/lib/harness-admin-client";
import { useMemo } from "react";

export function HarnessPage() {
  const api = useMemo(() => createPanelHarnessAdminApi(), []);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <HarnessAdminScreen api={api} basePath="/harness" surface="panel" />
    </div>
  );
}
