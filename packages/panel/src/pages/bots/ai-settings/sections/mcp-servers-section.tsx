import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { client } from "@/lib/client";
import { ExternalLink, Plug, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

type ServerListItem = Awaited<
  ReturnType<Awaited<ReturnType<(typeof client.api)["mcp-servers"]["$get"]>>["json"]>
>["data"][number];

export function McpServersSection({
  selectedIds,
  onUpdate,
}: {
  selectedIds: number[];
  onUpdate: (ids: number[]) => void;
}) {
  const [servers, setServers] = useState<ServerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation("aiSettings");

  useEffect(() => {
    client.api["mcp-servers"]
      .$get()
      .then((res) => res.json())
      .then((json) => {
        if (json.ok) setServers(json.data);
      })
      .catch(() => setError(t("mcpServers.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

  const toggle = (id: number) => {
    if (selectedIds.includes(id)) {
      onUpdate(selectedIds.filter((i) => i !== id));
    } else {
      onUpdate([...selectedIds, id]);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4" />
            {t("mcpServers.title")}
          </CardTitle>
          <Link
            to="/mcp-servers"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            {t("common.manage")}
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        ) : error ? (
          <p className="text-sm text-red-500">{error}</p>
        ) : servers.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("mcpServers.emptyBefore")}{" "}
            <Link to="/mcp-servers" className="text-primary underline">
              {t("mcpServers.addOne")}
            </Link>{" "}
            {t("mcpServers.emptyAfter")}
          </p>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => (
              <label
                key={server.id}
                className="hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-md p-2 transition-colors"
              >
                <Checkbox
                  checked={selectedIds.includes(server.id)}
                  onCheckedChange={() => toggle(server.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{server.name}</span>
                    <Badge variant={server.status.connected ? "success" : "destructive"}>
                      {server.status.connected
                        ? t("mcpServers.connected")
                        : t("mcpServers.disconnected")}
                    </Badge>
                    {server.status.toolCount > 0 && (
                      <Badge variant="muted">
                        <Wrench className="mr-1 h-3 w-3" />
                        {server.status.toolCount}
                      </Badge>
                    )}
                  </div>
                  {server.description && (
                    <div className="text-muted-foreground text-xs">{server.description}</div>
                  )}
                </div>
              </label>
            ))}
            <p className="text-muted-foreground mt-2 text-xs">{t("mcpServers.description")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
