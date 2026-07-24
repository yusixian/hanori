function normalizeDeliveryText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "");
}

/**
 * Returns true only when the complete model response is already present in
 * messages confirmed as delivered. False negatives may resend content, which
 * is safer than dropping an undelivered reply.
 */
export function isTextCoveredByDeliveries(text: string, deliveredMessages: string[]): boolean {
  const normalizedText = normalizeDeliveryText(text);
  if (!normalizedText) return true;
  return normalizeDeliveryText(deliveredMessages.join("\n")).includes(normalizedText);
}
