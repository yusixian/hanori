import { z } from "zod";

export type LayerName =
  | "default"
  | "kind"
  | "yaml"
  | "yaml:project"
  | "repo"
  | "inferred"
  | "panel:global"
  | "panel"
  | "override:global"
  | "override:project";

export const LAYER_LABELS: Record<LayerName, string> = {
  default: "内置默认",
  kind: "按 kind 推断",
  yaml: "harness.yaml",
  "yaml:project": "harness.yaml 项目",
  repo: "仓库策略文件",
  inferred: "按仓库推断",
  "panel:global": "面板设置（全局）",
  panel: "面板设置",
  "override:global": "覆盖层（全局）",
  "override:project": "覆盖层（项目）",
};

export interface ConfigLayer {
  name: LayerName;
  data: Record<string, unknown>;
  /** Maps a path in the merged tree to where the owner should fix it. */
  locate?: (path: string[]) => string;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type LayeredResult<T> = { ok: true; value: T } | { ok: false; issues: ConfigIssue[] };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge recursively; arrays, scalars, and null replace. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

export function mergeLayers(layers: readonly ConfigLayer[]): Record<string, unknown> {
  return layers.reduce<Record<string, unknown>>(
    (merged, layer) => deepMerge(merged, layer.data),
    {},
  );
}

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

export function splitPath(path: string): string[] | null {
  const segments = path.split(".");
  return segments.length > 0 && segments.every((segment) => SEGMENT_PATTERN.test(segment))
    ? segments
    : null;
}

export function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function hasPath(value: unknown, path: readonly string[]): boolean {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current) || !(segment in current)) return false;
    current = current[segment];
  }
  return true;
}

export function setPath(
  value: Record<string, unknown>,
  path: readonly string[],
  leaf: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (rest.length === 0) return { ...value, [head]: leaf };
  const child = isPlainObject(value[head]) ? value[head] : {};
  return { ...value, [head]: setPath(child, rest, leaf) };
}

/** A path is owned by the topmost layer that sets it or replaces one of its ancestors. */
export function findSourceLayer(
  layers: readonly ConfigLayer[],
  path: readonly string[],
): ConfigLayer | undefined {
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    for (let depth = path.length; depth > 0; depth--) {
      const prefix = path.slice(0, depth);
      if (!hasPath(layer.data, prefix)) continue;
      if (depth === path.length || !isPlainObject(getPath(layer.data, prefix))) return layer;
    }
  }
  return undefined;
}

export function sourceOf(layers: readonly ConfigLayer[], path: readonly string[]): LayerName {
  return findSourceLayer(layers, path)?.name ?? "default";
}

function locateIssue(layers: readonly ConfigLayer[], path: string[]): string {
  const layer = findSourceLayer(layers, path);
  if (layer?.locate) return layer.locate(path);
  return path.length > 0 ? path.join(".") : "(根)";
}

export function toConfigIssues(error: z.ZodError, layers: readonly ConfigLayer[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({ path: locateIssue(layers, [...path, key]), message: "未知字段" });
      }
      continue;
    }
    issues.push({ path: locateIssue(layers, path), message: issue.message });
  }
  return issues;
}

const zhCN = z.locales.zhCN().localeError;

export function parseLayered<S extends z.ZodType>(
  schema: S,
  layers: readonly ConfigLayer[],
): LayeredResult<z.output<S>> {
  const result = schema.safeParse(mergeLayers(layers), { error: zhCN });
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: toConfigIssues(result.error, layers) };
}

export function formatIssues(issues: readonly ConfigIssue[], limit = 20): string {
  const lines = issues.slice(0, limit).map((issue) => `${issue.path}: ${issue.message}`);
  if (issues.length > limit) lines.push(`…另有 ${issues.length - limit} 项`);
  return lines.join("\n");
}
