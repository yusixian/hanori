import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";

export function UnsavedChangesDialog({
  title,
  description,
  stayLabel,
  leaveLabel,
  busy = false,
  onStay,
  onLeave,
}: {
  title: string;
  description: string;
  stayLabel: string;
  leaveLabel: string;
  busy?: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(true);
  const onStayRef = useRef(onStay);
  const busyRef = useRef(busy);
  onStayRef.current = onStay;
  busyRef.current = busy;

  useEffect(() => {
    if (!busy) restoreFocusRef.current = true;
  }, [busy]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => stayButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (busyRef.current) return;
        onStayRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreFocusRef.current && previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overscroll-contain bg-slate-950/35 p-4 backdrop-blur-[2px]"
      onClick={(event) => event.target === event.currentTarget && !busy && onStay()}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-title"
        aria-describedby="unsaved-changes-description"
        aria-busy={busy}
        className="w-full max-w-md rounded-[20px] bg-white p-5 shadow-[0_24px_64px_rgb(15_23_42/0.22),0_0_0_1px_rgb(15_23_42/0.08)]"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
            <AlertTriangle aria-hidden="true" className="size-5" />
          </span>
          <div>
            <h2 id="unsaved-changes-title" className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            <p
              id="unsaved-changes-description"
              className="mt-1.5 text-sm leading-6 text-pretty text-slate-600"
            >
              {description}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={stayButtonRef}
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onStay}
          >
            {stayLabel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              restoreFocusRef.current = false;
              onLeave();
            }}
          >
            {leaveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
