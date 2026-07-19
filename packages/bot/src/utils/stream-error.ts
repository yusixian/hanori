/**
 * Keep the provider/transport failure observed while consuming a stream instead of
 * allowing a later aggregate-result read to replace it with a generic empty-output error.
 */
export function throwCapturedStreamError(error: unknown, outputStarted: boolean): void {
  if (error && !outputStarted) throw error;
}

/** Resolve complete provider output without replacing an earlier actionable stream error. */
export async function resolveCompleteStreamText(
  textResult: PromiseLike<string>,
  capturedStreamError: unknown,
): Promise<string> {
  try {
    return (await textResult).trim();
  } catch (resultError) {
    throwCapturedStreamError(capturedStreamError, false);
    throw resultError;
  }
}
