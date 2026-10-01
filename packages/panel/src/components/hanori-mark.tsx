import mark from "../../../docs/public/docs/icon.svg";

export function HanoriMark({ className }: { className?: string }) {
  return <img src={mark} alt="" aria-hidden="true" width={40} height={40} className={className} />;
}
