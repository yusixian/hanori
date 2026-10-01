import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { COLLAPSE_CHARACTER_THRESHOLD, COLLAPSE_LINE_THRESHOLD } from "./constants";
import { DisclosureIcon } from "./disclosure-icon";

export function CollapsibleContent({
  content,
  characterThreshold = COLLAPSE_CHARACTER_THRESHOLD,
  lineThreshold = COLLAPSE_LINE_THRESHOLD,
}: {
  content: string;
  characterThreshold?: number;
  lineThreshold?: number;
}) {
  const { t } = useTranslation("bots");
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const lines = content.split("\n");
  const exceedsLineLimit = lines.length > lineThreshold;
  const exceedsCharacterLimit = content.length > characterThreshold;
  const shouldCollapse = exceedsLineLimit || exceedsCharacterLimit;

  if (!shouldCollapse) {
    return <p className="break-words whitespace-pre-wrap">{content}</p>;
  }

  const linePreview = lines.slice(0, lineThreshold).join("\n").slice(0, characterThreshold);
  const preview = (exceedsLineLimit ? linePreview : content.slice(0, characterThreshold))
    .trimEnd()
    .concat("…");

  return (
    <div>
      <p id={contentId} className="break-words whitespace-pre-wrap">
        {expanded ? content : preview}
      </p>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring hover:bg-surface-subtle mt-1.5 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]"
        onClick={() => setExpanded((value) => !value)}
      >
        <DisclosureIcon expanded={expanded} />
        {expanded
          ? t("conversations.collapse")
          : exceedsLineLimit
            ? t("conversations.expandLines", { count: lines.length })
            : t("conversations.expandMessage")}
      </button>
    </div>
  );
}
