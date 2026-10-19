import type { PrepareStepFunction, PrepareStepResult, Tool } from "ai";

/** Leave a text-only step after collecting results or breaking a repeated Skill failure loop. */
export function prepareFinalAnswerStep<TOOLS extends Record<string, Tool>>(
  maxSteps: number,
  prepareStep?: PrepareStepFunction<TOOLS>,
): PrepareStepFunction<TOOLS> {
  return (options) => {
    const skillRetryLimit = options.steps.some((step) =>
      step.toolResults.some(
        (result) =>
          result.toolName === "load_skill" &&
          typeof result.output === "object" &&
          result.output !== null &&
          "code" in result.output &&
          result.output.code === "skill_retry_limit",
      ),
    );
    const finish = (prepared: PrepareStepResult<TOOLS>): PrepareStepResult<TOOLS> =>
      skillRetryLimit || (maxSteps >= 2 && options.stepNumber >= maxSteps - 1)
        ? { ...prepared, toolChoice: "none", activeTools: [] }
        : prepared;
    const prepared = prepareStep?.(options);
    return prepared && "then" in prepared ? prepared.then(finish) : finish(prepared);
  };
}
