/** Stops waiting without cancelling the operation; late rejections remain handled. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      operation.then(resolve, reject);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
