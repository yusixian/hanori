import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";

export function StickerPacksSection({
  stickerPacksText,
  onStickerPacksTextChange,
}: {
  stickerPacksText: string;
  onStickerPacksTextChange: (text: string) => void;
}) {
  const { t } = useTranslation("aiSettings");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("stickerPacks.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t("stickerPacks.names")}</label>
          <Input
            value={stickerPacksText}
            onChange={(e) => onStickerPacksTextChange(e.target.value)}
            placeholder="pack_name_1, pack_name_2"
          />
          <p className="text-muted-foreground text-xs">{t("stickerPacks.description")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
