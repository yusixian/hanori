import { admin as adminEn } from "../src/i18n/locales/en/admin";
import { aiSettings as aiSettingsEn } from "../src/i18n/locales/en/ai-settings";
import { auth as authEn } from "../src/i18n/locales/en/auth";
import { botData as botDataEn } from "../src/i18n/locales/en/bot-data";
import { bots as botsEn } from "../src/i18n/locales/en/bots";
import { common as commonEn } from "../src/i18n/locales/en/common";
import { harness as harnessEn } from "../src/i18n/locales/en/harness";
import { miniApp as miniAppEn } from "../src/i18n/locales/en/mini-app";
import { admin as adminZhCN } from "../src/i18n/locales/zh-CN/admin";
import { aiSettings as aiSettingsZhCN } from "../src/i18n/locales/zh-CN/ai-settings";
import { auth as authZhCN } from "../src/i18n/locales/zh-CN/auth";
import { botData as botDataZhCN } from "../src/i18n/locales/zh-CN/bot-data";
import { bots as botsZhCN } from "../src/i18n/locales/zh-CN/bots";
import { common as commonZhCN } from "../src/i18n/locales/zh-CN/common";
import { harness as harnessZhCN } from "../src/i18n/locales/zh-CN/harness";
import { miniApp as miniAppZhCN } from "../src/i18n/locales/zh-CN/mini-app";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ResourceTree = { readonly [key: string]: string | ResourceTree };

const pluralSuffix = /_(zero|one|two|few|many|other)$/;
const interpolation = /{{\s*([^},\s]+)[^}]*}}/g;

function collectLeaves(tree: ResourceTree, prefix = "", leaves = new Map<string, string>()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") leaves.set(path, value);
    else collectLeaves(value, path, leaves);
  }
  return leaves;
}

function normalizedKey(key: string) {
  return key.replace(pluralSuffix, "");
}

function groupLeaves(tree: ResourceTree) {
  const groups = new Map<string, string[]>();
  for (const [key, value] of collectLeaves(tree)) {
    const normalized = normalizedKey(key);
    groups.set(normalized, [...(groups.get(normalized) ?? []), value]);
  }
  return groups;
}

function interpolationVariables(values: string[]) {
  const variables = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(interpolation)) variables.add(match[1]!);
  }
  return [...variables].sort();
}

function difference(left: Set<string>, right: Set<string>) {
  return [...left].filter((key) => !right.has(key)).sort();
}

const namespaces: Record<string, { en: ResourceTree; zhCN: ResourceTree }> = {
  common: { en: commonEn, zhCN: commonZhCN },
  auth: { en: authEn, zhCN: authZhCN },
  admin: { en: adminEn, zhCN: adminZhCN },
  bots: { en: botsEn, zhCN: botsZhCN },
  botData: { en: botDataEn, zhCN: botDataZhCN },
  aiSettings: { en: aiSettingsEn, zhCN: aiSettingsZhCN },
  miniApp: { en: miniAppEn, zhCN: miniAppZhCN },
  harness: { en: harnessEn, zhCN: harnessZhCN },
};

const failures: string[] = [];
let checkedKeys = 0;
const groupedResources = new Map<string, Map<string, string[]>>();

for (const [namespace, resources] of Object.entries(namespaces)) {
  const en = groupLeaves(resources.en);
  const zhCN = groupLeaves(resources.zhCN);
  groupedResources.set(namespace, en);
  const enKeys = new Set(en.keys());
  const zhCNKeys = new Set(zhCN.keys());
  checkedKeys += enKeys.size;

  for (const key of difference(enKeys, zhCNKeys)) {
    failures.push(`${namespace}:${key} is missing from zh-CN`);
  }
  for (const key of difference(zhCNKeys, enKeys)) {
    failures.push(`${namespace}:${key} is missing from en`);
  }

  for (const key of [...enKeys].filter((candidate) => zhCNKeys.has(candidate))) {
    const enVariables = interpolationVariables(en.get(key)!);
    const zhCNVariables = interpolationVariables(zhCN.get(key)!);
    if (enVariables.join("\0") !== zhCNVariables.join("\0")) {
      failures.push(
        `${namespace}:${key} has different interpolation variables (en: ${enVariables.join(", ") || "none"}; zh-CN: ${zhCNVariables.join(", ") || "none"})`,
      );
    }
  }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(scriptDirectory, "../src");
const useTranslationPattern = /useTranslation\(\s*["']([^"']+)["']/;
const typedTranslationPattern = /TFunction<\s*["']([^"']+)["']/;
const staticTranslationPattern = /\bt\(\s*["']([^"']+)["']/g;
const staticTransPattern = /\bi18nKey=["']([^"']+)["']/g;

for (const file of sourceFiles(sourceDirectory)) {
  const source = readFileSync(file, "utf8");
  const defaultNamespace =
    source.match(useTranslationPattern)?.[1] ??
    source.match(typedTranslationPattern)?.[1] ??
    "common";

  for (const match of [
    ...source.matchAll(staticTranslationPattern),
    ...source.matchAll(staticTransPattern),
  ]) {
    const rawKey = match[1]!;
    const separatorIndex = rawKey.indexOf(":");
    const namespace = separatorIndex >= 0 ? rawKey.slice(0, separatorIndex) : defaultNamespace;
    const key = separatorIndex >= 0 ? rawKey.slice(separatorIndex + 1) : rawKey;
    const resources = groupedResources.get(namespace);
    if (!resources?.has(normalizedKey(key))) {
      const relativeFile = file.slice(sourceDirectory.length + 1);
      const line = source.slice(0, match.index).split("\n").length;
      failures.push(`${relativeFile}:${line} references missing key ${namespace}:${key}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`i18n validation failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `i18n validation passed for ${checkedKeys} normalized keys across ${Object.keys(namespaces).length} namespaces and all static calls.`,
  );
}
