import type { GovernanceSubjectOption } from "./governance-subject-picker";

type SubjectKind = "chat" | "user";
type SubjectSearch = (
  kind: SubjectKind,
  query: string,
  signal: AbortSignal,
) => Promise<GovernanceSubjectOption[]>;

interface ResolutionTask {
  key: string;
  kind: SubjectKind;
  value: string;
  promise: Promise<GovernanceSubjectOption | undefined>;
  controller?: AbortController;
  consumers: number;
  settled: boolean;
  resolve: (option: GovernanceSubjectOption | undefined) => void;
  reject: (error: unknown) => void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function createGovernanceSubjectResolver(search: SubjectSearch, maxConcurrent = 4) {
  const cache = new Map<string, GovernanceSubjectOption | undefined>();
  const pending = new Map<string, ResolutionTask>();
  const queue: ResolutionTask[] = [];
  const activeTasks = new Set<ResolutionTask>();
  let disposed = false;
  let lifecycleVersion = 0;

  const settle = (
    task: ResolutionTask,
    outcome: { option: GovernanceSubjectOption | undefined } | { error: unknown },
  ) => {
    if (task.settled) return;
    task.settled = true;
    if ("error" in outcome) task.reject(outcome.error);
    else task.resolve(outcome.option);
  };

  const drain = () => {
    while (!disposed && activeTasks.size < maxConcurrent) {
      const taskIndex = queue.findIndex((candidate) => candidate.consumers > 0);
      if (taskIndex < 0) return;
      const [task] = queue.splice(taskIndex, 1);
      if (!task) return;
      const controller = new AbortController();
      task.controller = controller;
      activeTasks.add(task);
      void search(task.kind, task.value, controller.signal)
        .then((options) => {
          if (disposed || controller.signal.aborted) throw abortError();
          const option = options.find((candidate) => candidate.value === task.value);
          cache.set(task.key, option);
          settle(task, { option });
        })
        .catch((error: unknown) => settle(task, { error }))
        .finally(() => {
          activeTasks.delete(task);
          if (pending.get(task.key) === task) pending.delete(task.key);
          drain();
        });
    }
  };

  const cancelIfUnused = (task: ResolutionTask) => {
    queueMicrotask(() => {
      if (task.consumers > 0 || task.settled) return;
      if (pending.get(task.key) === task) pending.delete(task.key);
      const queueIndex = queue.indexOf(task);
      if (queueIndex >= 0) queue.splice(queueIndex, 1);
      else task.controller?.abort();
      settle(task, { error: abortError() });
      drain();
    });
  };

  const waitForConsumer = (
    task: ResolutionTask,
    signal: AbortSignal,
  ): Promise<GovernanceSubjectOption | undefined> => {
    task.consumers += 1;
    drain();
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        task.consumers -= 1;
        callback();
        cancelIfUnused(task);
      };
      const abort = () => finish(() => reject(abortError()));
      signal.addEventListener("abort", abort, { once: true });
      void task.promise.then(
        (option) => finish(() => resolve(option)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const error = abortError();
    for (const task of queue.splice(0)) {
      if (pending.get(task.key) === task) pending.delete(task.key);
      settle(task, { error });
    }
    for (const task of activeTasks) {
      task.controller?.abort();
      settle(task, { error });
    }
  };

  return {
    resolve(kind: SubjectKind, value: string, signal: AbortSignal) {
      if (signal.aborted) return Promise.reject<GovernanceSubjectOption | undefined>(abortError());
      if (disposed) return Promise.reject<GovernanceSubjectOption | undefined>(abortError());
      const key = `${kind}:${value}`;
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      let task = pending.get(key);
      if (!task) {
        let resolveTask!: (option: GovernanceSubjectOption | undefined) => void;
        let rejectTask!: (error: unknown) => void;
        const promise = new Promise<GovernanceSubjectOption | undefined>((resolve, reject) => {
          resolveTask = resolve;
          rejectTask = reject;
        });
        task = {
          key,
          kind,
          value,
          promise,
          consumers: 0,
          settled: false,
          resolve: resolveTask,
          reject: rejectTask,
        };
        queue.push(task);
        pending.set(key, task);
        drain();
      }
      return waitForConsumer(task, signal);
    },
    retain() {
      lifecycleVersion += 1;
    },
    release() {
      const releaseVersion = ++lifecycleVersion;
      // StrictMode immediately re-runs effects with the same resolver; defer disposal so retain can cancel it.
      queueMicrotask(() => {
        if (releaseVersion === lifecycleVersion) dispose();
      });
    },
    dispose,
  };
}
