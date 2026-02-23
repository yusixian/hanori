import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function StickerPacksSection({
  stickerPacksText,
  onStickerPacksTextChange,
}: {
  stickerPacksText: string;
  onStickerPacksTextChange: (text: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sticker Packs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Sticker Pack Names</label>
          <Input
            value={stickerPacksText}
            onChange={(e) => onStickerPacksTextChange(e.target.value)}
            placeholder="pack_name_1, pack_name_2"
          />
          <p className="text-muted-foreground text-xs">
            Comma-separated sticker pack names. The AI can use stickers from these packs in replies.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
