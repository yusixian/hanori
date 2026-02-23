import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useInteractions,
  FloatingPortal,
  type Placement,
} from "@floating-ui/react";
import { cn } from "@/lib/utils";
import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";

interface PopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({
  trigger,
  children,
  placement = "bottom-start",
  className,
  open: controlledOpen,
  onOpenChange,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = controlledOpen ?? uncontrolledOpen;
  const setIsOpen = onOpenChange ?? setUncontrolledOpen;

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement,
    strategy: "fixed",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { ancestorScroll: true });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss]);

  return (
    <>
      {isValidElement(trigger) &&
        cloneElement(trigger, {
          ref: refs.setReference,
          ...getReferenceProps(),
        } as Record<string, unknown>)}
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className={cn(
              "bg-popover text-popover-foreground z-50 rounded-lg border shadow-md outline-none",
              className,
            )}
          >
            {children}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
