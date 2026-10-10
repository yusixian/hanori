/** Owns pending work; callers stop admitting new work before draining. */
export class InFlightTasks {
  private readonly tasks = new Set<Promise<unknown>>();

  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  async drain(): Promise<void> {
    // A pending operation can register child work before it settles.
    while (this.tasks.size) await Promise.allSettled(this.tasks);
  }
}
