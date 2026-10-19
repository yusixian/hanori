/** AI SDK result.text contains only the last step; earlier visible text still needs delivery. */
export function getTurnResponseTexts(
  finalText: string,
  steps: ReadonlyArray<{ text?: string }> | undefined,
): string[] {
  return [...(steps?.slice(0, -1).map((step) => step.text ?? "") ?? []), finalText]
    .map((text) => text.trim())
    .filter(Boolean);
}
