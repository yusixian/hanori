import { cn } from "@/lib/utils";
import { forwardRef, type ButtonHTMLAttributes } from "react";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-blue-700",
  destructive: "bg-destructive text-white hover:bg-red-700",
  outline: "border border-input bg-white hover:border-slate-400 hover:bg-slate-50",
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

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-[background-color,border-color,color] duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
