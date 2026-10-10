/** All graceful-exit signals share one attempt, including a failed attempt. */
export function createShutdownHandler(shutdown: (signal: NodeJS.Signals) => Promise<void>) {
  let task: Promise<void> | undefined;
  return (signal: NodeJS.Signals): Promise<void> => {
    if (task) return task;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    task = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    // Publish the attempt before starting synchronous shutdown side effects.
    try {
      shutdown(signal).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return task;
  };
}

/** Failed cleanup must not prevent later dependencies from being closed. */
export class ShutdownSteps {
  readonly failures: { step: string; error: unknown }[] = [];

  async run(step: string, cleanup: () => void | Promise<unknown>): Promise<void> {
    try {
      await cleanup();
    } catch (error) {
      this.failures.push({ step, error });
    }
  }
}
