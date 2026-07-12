/**
 * Keep the provider/transport failure observed while consuming a stream instead of
 * allowing a later aggregate-result read to replace it with a generic empty-output error.
 */
export function throwCapturedStreamError(error: unknown, outputStarted: boolean): void {
  if (error && !outputStarted) throw error;
}
