import { Pagination } from "@/components/ui/pagination";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";
import { PANE_MAX_HEIGHT } from "./constants";
import { MessageBubble } from "./message-bubble";
import type { ConversationMessage } from "./types";

function ScrollButtons({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="absolute right-3 bottom-3 flex flex-col gap-1">
      <button
        type="button"
        className="rounded-full bg-zinc-800/50 p-1.5 text-white opacity-50 transition hover:opacity-100 dark:bg-white/30"
        onClick={() => containerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
        title="Scroll to top"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="rounded-full bg-zinc-800/50 p-1.5 text-white opacity-50 transition hover:opacity-100 dark:bg-white/30"
        onClick={() =>
          containerRef.current?.scrollTo({
            top: containerRef.current.scrollHeight,
            behavior: "smooth",
          })
        }
        title="Scroll to bottom"
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function MessagesPane({
  messages,
  showTools,
  showSystem,
  onDelete,
  pendingDeleteId,
  containerRef,
  page,
  totalPages,
  onPageChange,
}: {
  messages: ConversationMessage[];
  showTools: boolean;
  showSystem: boolean;
  onDelete: (id: number) => void;
  pendingDeleteId: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  return (
    <>
      <div ref={containerRef} className={cn(PANE_MAX_HEIGHT, "space-y-3 overflow-y-auto pr-1")}>
        {messages
          .filter(
            (msg) =>
              (showTools || (msg.role !== "tool_call" && msg.role !== "tool_result")) &&
              (showSystem || msg.role !== "system"),
          )
          .map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              onDelete={onDelete}
              pendingDelete={pendingDeleteId === msg.id}
            />
          ))}
      </div>

      <ScrollButtons containerRef={containerRef} />

      <Pagination
        page={page}
        totalPages={totalPages}
        onPageChange={onPageChange}
        className="flex items-center justify-center gap-2 pt-3"
      />
    </>
  );
}
