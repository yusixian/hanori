import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Minus, Plus } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value: number | "";
  onValueChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const { t } = useTranslation("common");
  const adjust = (direction: -1 | 1) => {
    const current = value === "" ? 0 : Number(value);
    const next = current + direction * step;
    onValueChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)));
  };
  return (
    <div className="flex rounded-lg shadow-sm">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="rounded-r-none border-r-0 shadow-none"
        onClick={() => adjust(-1)}
        disabled={props.disabled || (value !== "" && min != null && Number(value) <= min)}
        aria-label={t("numberInput.decrease")}
      >
        <Minus className="size-4" />
      </Button>
      <Input
        {...props}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) =>
          onValueChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
        className={cn(
          "rounded-none text-center shadow-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          className,
        )}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="rounded-l-none border-l-0 shadow-none"
        onClick={() => adjust(1)}
        disabled={props.disabled || (value !== "" && max != null && Number(value) >= max)}
        aria-label={t("numberInput.increase")}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  );
}
