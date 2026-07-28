import type { AiExecutionConfig } from "@cos-tool-bot/shared";
import { DEFAULT_EXECUTION_CONFIG } from "./types";

export interface AiExecutionConfigDraft {
  maxConcurrentReplies: number | undefined;
  queueNotice: {
    enabled: boolean;
    text: string;
  };
}

export interface AiExecutionConfigErrors {
  maxConcurrentReplies?: "range";
  queueNoticeText?: "required" | "tooLong";
}

export function createExecutionConfigDraft(config?: AiExecutionConfig): AiExecutionConfigDraft {
  const resolved = config ?? DEFAULT_EXECUTION_CONFIG;
  return {
    maxConcurrentReplies: resolved.maxConcurrentReplies,
    queueNotice: { ...resolved.queueNotice },
  };
}

export function validateExecutionConfig(config: AiExecutionConfigDraft): AiExecutionConfigErrors {
  const errors: AiExecutionConfigErrors = {};
  const concurrency = config.maxConcurrentReplies;
  if (
    concurrency == null ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  ) {
    errors.maxConcurrentReplies = "range";
  }

  if (config.queueNotice.enabled) {
    const textLength = config.queueNotice.text.trim().length;
    if (textLength === 0) errors.queueNoticeText = "required";
    else if (textLength > 200) errors.queueNoticeText = "tooLong";
  }
  return errors;
}

export function toExecutionConfigUpdate(config: AiExecutionConfigDraft): AiExecutionConfig | null {
  if (Object.keys(validateExecutionConfig(config)).length > 0) return null;

  const text = config.queueNotice.text.trim();
  return {
    maxConcurrentReplies: config.maxConcurrentReplies!,
    queueNotice: {
      enabled: config.queueNotice.enabled,
      text,
    },
  };
}
