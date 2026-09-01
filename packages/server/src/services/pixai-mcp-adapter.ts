import { randomUUID } from "node:crypto";
import {
  PixaiMcpClient,
  PixaiMcpClientError,
  type PixaiMcpInlineImage,
  type PixaiMcpResourceLink,
} from "./pixai-mcp-client.js";

export interface PixaiPresetGenerationInput extends Record<string, unknown> {
  presetKey: string;
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  overrides?: Record<string, unknown>;
}

export interface PixaiPreparedGeneration {
  planId: string;
  approvalRequired: boolean;
  value: Record<string, unknown>;
}

export interface PixaiGenerationOperation {
  operationId: string;
  state?: string;
  phase?: string;
  terminal?: boolean;
  nextAction?: Record<string, unknown>;
  value: Record<string, unknown>;
}

export interface PixaiGenerationResult {
  operation: PixaiGenerationOperation;
  images: PixaiMcpInlineImage[];
  resourceLinks: PixaiMcpResourceLink[];
}

export interface PixaiCreateGenerationResult {
  prepared: PixaiPreparedGeneration;
  operation: PixaiGenerationOperation;
}

export class PixaiMcpContractError extends Error {
  constructor(readonly field: "planId" | "operationId" | "result") {
    super("PixAI MCP response did not match the generation contract");
    this.name = "PixaiMcpContractError";
  }
}

/**
 * Image-generation port for the PixAI MCP workflow. Callers do not need to know
 * MCP content blocks or the prepare/generate operation handshake.
 */
export class PixaiMcpAdapter {
  constructor(private readonly client: PixaiMcpClient) {}

  async listPresets(signal?: AbortSignal): Promise<unknown[]> {
    const response = await this.client.getCapabilities<Record<string, unknown>>(signal);
    return Array.isArray(response.result["generationPresets"])
      ? response.result["generationPresets"]
      : [];
  }

  async getCapabilities(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.client.getCapabilities(signal);
    return expectRecord(response.result, "result");
  }

  async listModels(signal?: AbortSignal): Promise<unknown[]> {
    const response = await this.client.listModels(signal);
    if (Array.isArray(response.result)) return response.result;
    const value = expectRecord(response.result, "result");
    return Array.isArray(value["models"]) ? value["models"] : [];
  }

  async prepareGeneration(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PixaiPreparedGeneration> {
    const response = await this.client.prepareGeneration(input, signal);
    const value = expectRecord(response.result, "result");
    const planId = readString(value, "planId") ?? readNestedString(value, "plan", "id");
    if (!planId) throw new PixaiMcpContractError("planId");
    const approval = isRecord(value["approval"]) ? value["approval"] : undefined;
    return {
      planId,
      approvalRequired: approval?.["required"] === true,
      value,
    };
  }

  async startGeneration(
    planId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PixaiGenerationOperation> {
    const response = await this.client.generate({ planId, idempotencyKey }, signal);
    return toOperation(response.result);
  }

  async createGeneration(
    input: Record<string, unknown>,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<PixaiCreateGenerationResult> {
    const prepared = await this.prepareGeneration(input, options.signal);
    const operation = await this.startGeneration(
      prepared.planId,
      options.idempotencyKey ?? `cos-tool-bot:${randomUUID()}`,
      options.signal,
    );
    return { prepared, operation };
  }

  async getGeneration(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<PixaiGenerationOperation> {
    const response = await this.client.getTask(operationId, signal);
    return toOperation(response.result, operationId);
  }

  async getGenerationDetails(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.client.getGenerationDetails(operationId, signal);
    return expectRecord(response.result, "result");
  }

  async waitForGeneration(
    operationId: string,
    timeoutMs = 5_000,
    signal?: AbortSignal,
  ): Promise<PixaiGenerationOperation> {
    const response = await this.client.waitForResult(operationId, timeoutMs, signal);
    return toOperation(response.result, operationId);
  }

  async getGenerationResult(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<PixaiGenerationResult> {
    const response = await this.client.getResult(operationId, signal);
    return {
      operation: toOperation(response.result, operationId),
      images: response.images,
      resourceLinks: response.resourceLinks,
    };
  }

  async cancelGeneration(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<PixaiGenerationOperation> {
    const response = await this.client.cancelTask(operationId, signal);
    return toOperation(response.result, operationId);
  }
}

function toOperation(value: unknown, expectedOperationId?: string): PixaiGenerationOperation {
  const record = expectRecord(value, "result");
  const operationRecord = isRecord(record["operation"]) ? record["operation"] : undefined;
  const operationId =
    readString(record, "operationId") ??
    (operationRecord ? readString(operationRecord, "id") : undefined) ??
    expectedOperationId;
  if (!operationId) throw new PixaiMcpContractError("operationId");

  const experience = isRecord(record["experience"]) ? record["experience"] : undefined;
  const nextAction =
    experience && isRecord(experience["nextAction"]) ? experience["nextAction"] : undefined;
  return {
    operationId,
    state:
      readString(record, "state") ??
      (operationRecord ? readString(operationRecord, "state") : undefined),
    phase: experience ? readString(experience, "phase") : readString(record, "phase"),
    terminal:
      typeof experience?.["terminal"] === "boolean"
        ? experience["terminal"]
        : typeof record["terminal"] === "boolean"
          ? record["terminal"]
          : undefined,
    nextAction,
    value: record,
  };
}

function expectRecord(
  value: unknown,
  field: "planId" | "operationId" | "result",
): Record<string, unknown> {
  if (!isRecord(value)) throw new PixaiMcpContractError(field);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" && value[key] ? value[key] : undefined;
}

function readNestedString(
  value: Record<string, unknown>,
  parent: string,
  child: string,
): string | undefined {
  const nested = value[parent];
  return isRecord(nested) ? readString(nested, child) : undefined;
}

export function isPixaiMcpUnavailable(error: unknown): boolean {
  return (
    error instanceof PixaiMcpClientError &&
    (error.code === "AUTHORIZATION_REQUIRED" ||
      error.code === "CONNECTION_FAILED" ||
      error.code === "NOT_CONNECTED")
  );
}
