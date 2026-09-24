import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { type ConfigIssue, isPlainObject, toConfigIssues } from "./layers.js";
import { resolveGlobalConfig, resolveProjectConfig } from "./resolve.js";
import { type HarnessFileConfig, type RepoPolicy, repoPolicySchema } from "./schema.js";

export interface LoadedHarnessConfig {
  raw: Record<string, unknown>;
  file: HarnessFileConfig;
  sourcePath: string;
  loadedAt: Date;
}

export type YamlParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ConfigIssue[] };

export function parseYamlObject(text: string, label: string): YamlParseResult {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => {
        const position = error.linePos?.[0];
        return {
          path: position ? `${label}:${position.line}:${position.col}` : label,
          message:
            error.message.split("\n", 1)[0]?.replace(/ at line \d+, column \d+:?$/, "") ||
            "YAML 语法错误",
        };
      }),
    };
  }
  const value: unknown = document.toJS({ maxAliasCount: 50 });
  if (value === null || value === undefined) return { ok: true, value: {} };
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ path: label, message: "顶层必须是对象" }] };
  }
  return { ok: true, value };
}

export type ConfigValidation =
  | { ok: true; config: LoadedHarnessConfig }
  | { ok: false; issues: ConfigIssue[] };

/** Validates the file as a whole and every project's merged view so errors carry field paths. */
export function validateHarnessConfig(input: {
  raw: Record<string, unknown>;
  sourcePath: string;
  policies?: ReadonlyMap<string, Record<string, unknown> | null>;
  now: Date;
}): ConfigValidation {
  const global = resolveGlobalConfig(input.raw, [], input.now);
  if (!global.ok) return { ok: false, issues: global.issues };
  const issues: ConfigIssue[] = [];
  for (const projectKey of Object.keys(global.value.projects)) {
    const project = resolveProjectConfig({
      raw: input.raw,
      projectKey,
      policy: input.policies?.get(projectKey) ?? null,
      overrides: [],
      now: input.now,
    });
    if (!project.ok) issues.push(...project.issues);
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: {
      raw: input.raw,
      file: global.value,
      sourcePath: input.sourcePath,
      loadedAt: input.now,
    },
  };
}

export async function loadHarnessConfigFile(
  sourcePath: string,
  now = new Date(),
): Promise<ConfigValidation> {
  let text: string;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      issues: [
        { path: sourcePath, message: code === "ENOENT" ? "文件不存在" : `无法读取（${code}）` },
      ],
    };
  }
  const parsed = parseYamlObject(text, "harness.yaml");
  if (!parsed.ok) return parsed;
  return validateHarnessConfig({ raw: parsed.value, sourcePath, now });
}

export type RepoPolicyParse =
  | { ok: true; raw: Record<string, unknown>; policy: RepoPolicy }
  | { ok: false; issues: ConfigIssue[] };

export function parseRepoPolicy(text: string): RepoPolicyParse {
  const parsed = parseYamlObject(text, ".cos/harness.yml");
  if (!parsed.ok) return parsed;
  const result = repoPolicySchema.safeParse(parsed.value);
  if (result.success) return { ok: true, raw: parsed.value, policy: result.data };
  return {
    ok: false,
    issues: toConfigIssues(result.error, [
      {
        name: "repo",
        data: parsed.value,
        locate: (path) => `.cos/harness.yml: ${path.join(".") || "(根)"}`,
      },
    ]),
  };
}
