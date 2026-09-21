export class KeyedAsyncLock {
  private readonly locks = new Map<string, Promise<void>>();

  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return result;
  }
}
