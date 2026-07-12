import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function InlineDisclosure({
  title,
  children,
  className,
  contentClassName,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Accordion type="single" collapsible className={className}>
      <AccordionItem value="content">
        <AccordionTrigger className="text-muted-foreground min-h-9 justify-start gap-1 text-xs font-medium [&>span:last-child]:ml-auto">
          <span>{title}</span>
        </AccordionTrigger>
        <AccordionContent className={cn("pt-1.5", contentClassName)}>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
