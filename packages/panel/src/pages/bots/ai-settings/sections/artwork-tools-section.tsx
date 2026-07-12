import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ArtworkToolsConfig } from "@cos-tool-bot/shared";

export function ArtworkToolsSection({
  config,
  onUpdate,
}: {
  config: ArtworkToolsConfig;
  onUpdate: (updates: Partial<ArtworkToolsConfig>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Artwork Tools</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="artworkToolsEnabled"
            checked={config.enabled}
            onCheckedChange={(enabled) => onUpdate({ enabled })}
          />
          <label htmlFor="artworkToolsEnabled" className="text-sm font-medium">
            Enable Artwork Tools
          </label>
        </div>
        <p className="text-muted-foreground text-xs">
          When enabled, the AI can fetch artwork info and send images from supported platforms
          (Pixiv, Twitter/X). More platforms can be added in the future.
        </p>

        <div className="space-y-1.5">
          <label className="text-sm font-medium">Pixiv Cookie</label>
          <Input
            type="password"
            disabled={!config.enabled}
            value={config.pixivCookie ?? ""}
            onChange={(e) => onUpdate({ pixivCookie: e.target.value || undefined })}
            placeholder="Pixiv login cookie (required for Pixiv support)"
          />
          <p className="text-muted-foreground text-xs">
            Required for Pixiv artwork fetching. Get it from your browser's DevTools (cookie header
            from pixiv.net). Twitter/X works without any credentials.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
