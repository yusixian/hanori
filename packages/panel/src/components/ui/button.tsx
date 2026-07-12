import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

const variants = {
  default:
    "bg-primary text-primary-foreground shadow-[0_8px_18px_rgb(37_99_235/0.2)] hover:bg-blue-700 hover:shadow-[0_10px_22px_rgb(37_99_235/0.26)]",
  destructive: "bg-destructive text-white shadow-[0_8px_18px_rgb(220_38_38/0.16)] hover:bg-red-700",
  outline: "border border-input bg-white/80 shadow-sm hover:border-blue-200 hover:bg-blue-50/60",
  ghost: "hover:bg-accent hover:text-accent-foreground",
} as const;

const sizes = {
  default: "h-10 px-4 py-2",
  sm: "h-10 px-3.5 text-sm",
  lg: "h-11 px-6",
  icon: "h-10 w-10",
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-[scale,background-color,border-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
