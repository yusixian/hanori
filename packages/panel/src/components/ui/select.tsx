import { SelectMenu, type SelectMenuOption } from "@/components/ui/select-menu";
import {
  Children,
  isValidElement,
  type ChangeEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

const EMPTY_VALUE = "__select_empty_value__";

function collectOptions(children: ReactNode): SelectMenuOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        value?: string | number;
        children?: ReactNode;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === "option") {
      const value = String(child.props.value ?? "");
      return [
        {
          value: value === "" ? EMPTY_VALUE : value,
          label: String(child.props.children ?? ""),
          disabled: child.props.disabled,
        },
      ];
    }
    return collectOptions(child.props.children);
  });
}

export function Select({
  value,
  defaultValue,
  onChange,
  children,
  className,
  disabled,
  id,
  "aria-label": ariaLabel,
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <SelectMenu
      id={id}
      value={String(value ?? defaultValue ?? "") || EMPTY_VALUE}
      disabled={disabled}
      className={className}
      ariaLabel={ariaLabel}
      options={collectOptions(children)}
      onValueChange={(nextValue) => {
        const resolvedValue = nextValue === EMPTY_VALUE ? "" : nextValue;
        onChange?.({
          target: { value: resolvedValue },
          currentTarget: { value: resolvedValue },
        } as ChangeEvent<HTMLSelectElement>);
      }}
    />
  );
}
