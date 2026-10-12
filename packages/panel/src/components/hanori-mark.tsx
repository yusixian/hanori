import mark from "../../../docs/public/docs/icon.svg?raw";
import "../../../docs/app/lib/hanori-mark.css";

export function HanoriMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`hanori-mark ${className ?? ""}`}
      // Only the bundled, repository-owned SVG is inserted here.
      dangerouslySetInnerHTML={{ __html: mark }}
    />
  );
}
