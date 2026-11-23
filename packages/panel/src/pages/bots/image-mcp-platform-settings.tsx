import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/client";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface PlatformSettings {
  baseUrl: string;
  revision: number;
}

export function ImageMcpPlatformSettings({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation("bots");
  const [saved, setSaved] = useState<PlatformSettings>();
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await authFetch("/api/image-mcp-platform", { signal: controller.signal });
        const body = (await response.json()) as { ok?: boolean; data?: PlatformSettings };
        if (
          !response.ok ||
          !body.ok ||
          typeof body.data?.baseUrl !== "string" ||
          typeof body.data.revision !== "number"
        )
          throw new Error();
        if (controller.signal.aborted) return;
        setSaved(body.data);
        setAddress(body.data.baseUrl);
      } catch {
        if (!controller.signal.aborted) setError(t("governance.platform.loadError"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [retry, t]);

  const save = async () => {
    if (!saved) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await authFetch("/api/image-mcp-platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: address, revision: saved.revision }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: PlatformSettings;
        error?: string;
      };
      if (!response.ok || !body.ok || !body.data) {
        setError(
          t(
            body.error === "invalid_configuration"
              ? "governance.platform.invalidAddress"
              : body.error === "conflict"
                ? "governance.platform.conflict"
                : "governance.platform.saveError",
          ),
        );
        return;
      }
      setSaved(body.data);
      setAddress(body.data.baseUrl);
      setNotice(t("governance.platform.saved"));
      onSaved();
    } catch {
      setError(t("governance.platform.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("governance.platform.title")}</CardTitle>
        <CardDescription>{t("governance.platform.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="image-mcp-platform-address">{t("governance.platform.address")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id="image-mcp-platform-address"
                value={address}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="mcp.example.com"
                disabled={loading || saving || !saved}
                aria-describedby="image-mcp-platform-hint"
                aria-invalid={!!error}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setNotice("");
                  setError("");
                }}
              />
              <Button type="submit" className="shrink-0" disabled={loading || saving || !saved}>
                {(loading || saving) && (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                )}
                {t("governance.platform.save")}
              </Button>
            </div>
            <p id="image-mcp-platform-hint" className="text-muted-foreground text-sm">
              {t("governance.platform.hint")}
            </p>
          </div>
          {error && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={loading || saving}
                onClick={() => setRetry((value) => value + 1)}
              >
                {t("governance.refresh")}
              </Button>
            </div>
          )}
          {notice && (
            <p className="text-muted-foreground text-sm" role="status">
              {notice}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
