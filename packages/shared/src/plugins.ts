/** Versioned, serializable plugin metadata shared by the host and configuration form. */
export interface PluginConfigField {
  key: string;
  label: string;
  description?: string;
  type: "string" | "text" | "number" | "integer" | "boolean" | "select";
  secret?: boolean;
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
}

export type PluginConfigValue = string | number | boolean;
export type PluginConfiguration = Record<string, PluginConfigValue>;

export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  config: PluginConfigField[];
}

/** Secrets are write-only: an omitted or blank update preserves them, null clears them. */
export interface PluginConfigUpdate {
  /** null resets an ordinary field to its default, or removes it if it has no default. */
  values: Record<string, PluginConfigValue | null>;
  secrets?: Record<string, string | null>;
}

export interface PluginConfigPublic {
  values: PluginConfiguration;
  configuredSecrets: string[];
}

const FIELD_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const RESERVED_KEYS = new Set(["prototype", ...Object.getOwnPropertyNames(Object.prototype)]);
const FIELD_TYPES = new Set(["string", "text", "number", "integer", "boolean", "select"]);
const MAX_STRING_LENGTH = 16_384;

export class PluginConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "PluginConfigError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownValue<T>(values: Record<string, T> | undefined, key: string): T | undefined {
  return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validValue(field: PluginConfigField, value: unknown): value is PluginConfigValue {
  switch (field.type) {
    case "string":
    case "text":
      return (
        typeof value === "string" &&
        value.length <= (field.max ?? MAX_STRING_LENGTH) &&
        value.length >= (field.min ?? 0)
      );
    case "select":
      return (
        typeof value === "string" &&
        field.options?.some((option) => option.value === value) === true
      );
    case "boolean":
      return typeof value === "boolean";
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (field.type !== "integer" || Number.isInteger(value)) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max)
      );
  }
}

/** Validate metadata before rendering it or executing a plugin entry point. */
export function parsePluginManifest(input: unknown): PluginManifest {
  if (
    !record(input) ||
    input.apiVersion !== 1 ||
    typeof input.id !== "string" ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(input.id) ||
    input.id.length > 100 ||
    !boundedText(input.name, 100) ||
    !boundedText(input.author, 100) ||
    !boundedText(input.version, 64) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.version) ||
    !boundedText(input.description, 2_000) ||
    !Array.isArray(input.config) ||
    input.config.length > 64
  ) {
    throw new PluginConfigError("Invalid plugin manifest");
  }
  if (input.homepage !== undefined) {
    try {
      const url = new URL(String(input.homepage));
      if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2_000)
        throw new Error();
    } catch {
      throw new PluginConfigError("Invalid plugin homepage");
    }
  }
  const keys = new Set<string>();
  const config: PluginConfigField[] = input.config.map((value: unknown) => {
    if (
      !record(value) ||
      typeof value.key !== "string" ||
      !FIELD_KEY.test(value.key) ||
      RESERVED_KEYS.has(value.key) ||
      keys.has(value.key) ||
      !boundedText(value.label, 200) ||
      typeof value.type !== "string" ||
      !FIELD_TYPES.has(value.type)
    ) {
      throw new PluginConfigError("Invalid or duplicate plugin configuration field");
    }
    keys.add(value.key);
    if (value.description !== undefined && !boundedText(value.description, 2_000)) {
      throw new PluginConfigError("Invalid field description", value.key);
    }
    for (const flag of ["secret", "required"] as const) {
      if (value[flag] !== undefined && typeof value[flag] !== "boolean") {
        throw new PluginConfigError("Invalid field flag", value.key);
      }
    }
    if (value.secret && value.type !== "string" && value.type !== "text") {
      throw new PluginConfigError("Only text fields can contain secrets", value.key);
    }
    for (const bound of ["min", "max"] as const) {
      if (
        value[bound] !== undefined &&
        (typeof value[bound] !== "number" || !Number.isFinite(value[bound]))
      ) {
        throw new PluginConfigError("Invalid field bounds", value.key);
      }
    }
    if (typeof value.min === "number" && typeof value.max === "number" && value.min > value.max) {
      throw new PluginConfigError("Invalid field bounds", value.key);
    }
    if (
      (value.type === "string" || value.type === "text") &&
      [value.min, value.max].some(
        (bound) =>
          bound !== undefined &&
          (!Number.isInteger(bound) ||
            (bound as number) < 0 ||
            (bound as number) > MAX_STRING_LENGTH),
      )
    ) {
      throw new PluginConfigError("Invalid text length bounds", value.key);
    }
    let options: PluginConfigField["options"];
    if (value.type === "select") {
      if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 100) {
        throw new PluginConfigError("A select field requires options", value.key);
      }
      const seen = new Set<string>();
      options = value.options.map((option: unknown) => {
        if (
          !record(option) ||
          !boundedText(option.value, 200) ||
          !boundedText(option.label, 200) ||
          seen.has(option.value)
        ) {
          throw new PluginConfigError("Invalid select option", value.key as string);
        }
        seen.add(option.value);
        return { value: option.value, label: option.label };
      });
    }
    const field: PluginConfigField = {
      key: value.key,
      label: value.label,
      type: value.type as PluginConfigField["type"],
      ...(value.description === undefined ? {} : { description: value.description as string }),
      ...(value.secret === undefined ? {} : { secret: value.secret as boolean }),
      ...(value.required === undefined ? {} : { required: value.required as boolean }),
      ...(value.min === undefined ? {} : { min: value.min as number }),
      ...(value.max === undefined ? {} : { max: value.max as number }),
      ...(options ? { options } : {}),
    };
    if (value.default !== undefined) {
      if (field.secret || !validValue(field, value.default)) {
        throw new PluginConfigError(
          "Invalid field default; secrets cannot have defaults",
          field.key,
        );
      }
      field.default = value.default;
    }
    return field;
  });
  return {
    apiVersion: 1,
    id: input.id,
    name: input.name,
    version: input.version,
    description: input.description,
    author: input.author,
    config,
    ...(input.homepage === undefined ? {} : { homepage: String(input.homepage) }),
  };
}

export function publicPluginConfig(
  manifest: PluginManifest,
  values: PluginConfiguration,
): PluginConfigPublic {
  const visible: PluginConfiguration = {};
  const configuredSecrets: string[] = [];
  for (const field of manifest.config) {
    const value = ownValue(values, field.key) ?? field.default;
    if (field.secret) {
      if (typeof value === "string" && value.length > 0) configuredSecrets.push(field.key);
    } else if (value !== undefined) {
      visible[field.key] = value;
    }
  }
  return { values: visible, configuredSecrets };
}

export function mergePluginConfig(
  manifest: PluginManifest,
  current: PluginConfiguration,
  update: PluginConfigUpdate,
  requireComplete = false,
): PluginConfiguration {
  if (!record(update.values) || (update.secrets !== undefined && !record(update.secrets))) {
    throw new PluginConfigError("Invalid plugin configuration update");
  }
  const fields = new Map(manifest.config.map((field) => [field.key, field]));
  for (const key of Object.keys(update.values)) {
    if (!fields.has(key) || fields.get(key)!.secret)
      throw new PluginConfigError("Unknown or secret configuration field", key);
  }
  for (const key of Object.keys(update.secrets ?? {})) {
    if (!fields.get(key)?.secret) throw new PluginConfigError("Unknown secret field", key);
  }
  const result: PluginConfiguration = {};
  for (const field of manifest.config) {
    const secret = ownValue(update.secrets, field.key);
    const value = field.secret
      ? secret === null
        ? undefined
        : secret === "" || secret === undefined
          ? ownValue(current, field.key)
          : secret
      : Object.hasOwn(update.values, field.key)
        ? (update.values[field.key] ?? field.default)
        : (ownValue(current, field.key) ?? field.default);
    if (value !== undefined && !validValue(field, value))
      throw new PluginConfigError("Invalid configuration value", field.key);
    if (
      requireComplete &&
      field.required &&
      (value === undefined || (typeof value === "string" && value.trim() === ""))
    ) {
      throw new PluginConfigError("Required configuration field is missing", field.key);
    }
    if (value !== undefined) result[field.key] = value;
  }
  return result;
}
