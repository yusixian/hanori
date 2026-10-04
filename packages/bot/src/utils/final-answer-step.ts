import type { PrepareStepFunction, PrepareStepResult, Tool } from "ai";

/** Leave a text-only step inside the turn budget after collecting tool results. */
export function prepareFinalAnswerStep<TOOLS extends Record<string, Tool>>(
  maxSteps: number,
  prepareStep?: PrepareStepFunction<TOOLS>,
): PrepareStepFunction<TOOLS> {
  return (options) => {
    const finish = (prepared: PrepareStepResult<TOOLS>): PrepareStepResult<TOOLS> =>
      maxSteps >= 2 && options.stepNumber >= maxSteps - 1
        ? { ...prepared, toolChoice: "none", activeTools: [] }
        : prepared;
    const prepared = prepareStep?.(options);
    return prepared && "then" in prepared ? prepared.then(finish) : finish(prepared);
  };
}
