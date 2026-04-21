import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { COLLAPSE_LINE_THRESHOLD } from "./constants";

export function CollapsibleContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const shouldCollapse = lines.length > COLLAPSE_LINE_THRESHOLD;

  if (!shouldCollapse) {
    return <p className="text-sm whitespace-pre-wrap">{content}</p>;
  }

  const preview = lines.slice(0, COLLAPSE_LINE_THRESHOLD).join("\n");

  return (
    <div>
      <p className="text-sm whitespace-pre-wrap">{expanded ? content : `${preview}\n...`}</p>
      <button
        type="button"
        className="mt-1 flex items-center gap-1 text-xs opacity-60 hover:opacity-100"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <>
            <ChevronUp className="h-3 w-3" /> Collapse
          </>
        ) : (
          <>
            <ChevronDown className="h-3 w-3" /> Expand ({lines.length} lines)
          </>
        )}
      </button>
    </div>
  );
}
