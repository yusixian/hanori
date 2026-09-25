import type { HarnessCommandRequest, HarnessReply } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { type ConfigIssue, getPath, mergeLayers, sourceOf, splitPath } from "./config/layers.js";
import {
  GLOBAL_SCOPE,
  type HarnessOverride,
  activeOverrides,
  isLockedPath,
  resolveGlobalConfig,
  resolveProjectConfig,
} from "./config/resolve.js";
import { executionLayerData } from "./config/execution.js";
import { parseDuration } from "./config/units.js";
import { findMachine, type LodyMachine } from "./lody.js";
import {
  MESSAGE_LIMIT,
  formatDateTime,
  renderConfigValue,
  renderExecutionLine,
  renderIssues,
  renderQuota,
  toYaml,
  topicLink,
} from "./render.js";
import { handleBugCommand } from "./bug.js";
import { listRequests, runControl } from "./controls.js";
import { ACTIVE_STATES, OPEN_PR_STATES, WAITING_STATES } from "./states.js";
import type { HarnessService } from "./service.js";

const HARNESS_USAGE = [
  "<b>/harness</b> 用法（在项目话题中执行时限定该项目）",
  "config [路径] — 生效值与来源层",
  "set &lt;路径&gt; &lt;值&gt; [--ttl 1d] — 写入覆盖层",
  "unset &lt;路径&gt; — 删除覆盖",
  "diff — 覆盖层与 YAML 的差异",
  "export — 以文件导出生效配置",
  "reload — 重新读取 harness.yaml，失败时保留旧配置",
  "",
  "日常操作：/list 进行中的请求 · /cancel [ID|#编号] 取消 · /retry [ID|#编号] 重新排队",
  "<b>话题助手</b>：在话题里直接发文字即可讨论需求、查询 issue / PR 与任务状态，建议的命令可一键执行；/new 清空本话题的对话",
].join("\n");

const html = (text: string): HarnessReply => ({ html: text });

/**
 * Telegram rejects `web_app` buttons in groups, so this is a `url` button: the Bot's main Mini
 * App via `startapp` when it has one, else the web panel page.
 */
function withManageButton(
  service: HarnessService,
  request: HarnessCommandRequest,
  text: string,
): HarnessReply {
  const url =
    service.botHasMiniApp && request.botUsername
      ? `https://t.me/${request.botUsername}?startapp=harness`
      : service.adminUrl;
  return url ? { html: text, keyboard: [[{ text: "⚙️ 管理项目", url }]] } : html(text);
}

export async function handleHarnessCommand(
  service: HarnessService,
  request: HarnessCommandRequest,
): Promise<HarnessReply> {
  if (!service.active) return html("Dev Harness 配置未加载，请检查服务端日志。");
  if (!service.port.isHarnessChat(request.chatId) || !service.port.isOwner(request.userId)) {
    return html("无权限");
  }
  const projectKey = service.projectKeyForThread(request.threadId);
  switch (request.command) {
    case "status":
      return withManageButton(
        service,
        request,
        projectKey ? await projectStatus(service, projectKey) : await globalStatus(service),
      );
    case "quota":
      return html(await quota(service, projectKey));
    case "harness":
      return harnessSubcommand(service, request, projectKey);
    case "bug":
      return handleBugCommand(service.work, request, projectKey);
    case "list":
      return listRequests(service, projectKey);
    case "cancel":
    case "retry":
      return runControl(service, request.command, request, projectKey);
    case "new":
      return service.assistant.reset(request.chatId, request.threadId);
  }
}

function targetMachines(service: HarnessService, projectKey: string | undefined) {
  const { machines } = service.globalView().config;
  const wanted = projectKey ? (service.projectView(projectKey)?.config.project.machines ?? []) : [];
  const keys = wanted.length > 0 ? wanted : Object.keys(machines);
  return keys
    .map((key) => machines[key])
    .filter((machine) => machine?.enabled)
    .map((machine) => machine!.lody);
}

async function lodyMachines(service: HarnessService, projectKey: string | undefined) {
  const result = await service.lody().listMachines();
  if (!result.ok) return { result, machines: [] as LodyMachine[], missing: [] as string[] };
  const refs = targetMachines(service, projectKey);
  if (refs.length === 0) return { result, machines: result.value, missing: [] as string[] };
  const machines: LodyMachine[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const machine = findMachine(result.value, ref);
    if (machine) machines.push(machine);
    else missing.push(ref);
  }
  return { result, machines, missing };
}

async function quota(service: HarnessService, projectKey: string | undefined): Promise<string> {
  const { result, machines, missing } = await lodyMachines(service, projectKey);
  const text = renderQuota({
    result,
    machines,
    timeZone: service.globalView().config.telegram.notify.timezone,
  });
  return missing.length > 0
    ? `${text}\n\n未在 Lody 中找到：${escapeHtml(missing.join("、"))}`
    : text;
}

async function globalStatus(service: HarnessService): Promise<string> {
  const view = service.globalView();
  const config = view.config;
  const loaded = service.loadedConfig!;
  const timeZone = config.telegram.notify.timezone;
  const lines = [
    "<b>Dev Harness</b>",
    `配置：${escapeHtml(basename(loaded.sourcePath))} · 加载于 ${formatDateTime(loaded.loadedAt, timeZone)}`,
  ];
  lines.push(
    service.botId
      ? `Bot：${escapeHtml(service.botName ?? "")}（<code>${escapeHtml(service.botId)}</code>）`
      : `Bot：尚未绑定（telegram.bot = ${escapeHtml(config.telegram.bot)}）`,
  );
  const reloadError = service.lastReloadError;
  if (reloadError) {
    lines.push(
      `⚠️ ${formatDateTime(reloadError.at, timeZone)} reload 失败，仍使用上一次配置：<code>${escapeHtml(
        reloadError.issues[0]?.path ?? "",
      )}</code> ${escapeHtml(reloadError.issues[0]?.message ?? "")}`,
    );
  }
  if (view.overrideIssues) lines.push("⚠️ 覆盖层与当前 YAML 冲突，已暂时忽略，见 /harness diff");
  const overrides = service.overrideList.filter(
    (o) => o.expiresAt === null || o.expiresAt > service.now(),
  );
  lines.push(`覆盖层：${overrides.length} 项`);
  const secretEnv = config.github.webhookSecretEnv;
  lines.push(
    `GitHub App：${service.github?.available ? "可用" : "未配置"} · Webhook 密钥：${
      service.readEnv(secretEnv) ? "已设置" : `未设置（${escapeHtml(secretEnv)}）`
    }`,
  );
  const { result, machines } = await lodyMachines(service, undefined);
  const transport = service.lodyTransport() === "bridge" ? "lody-bridge" : "本地 lody CLI";
  lines.push(`${renderExecutionLine(result, machines)} · 经${transport}`);
  lines.push("", "<b>项目</b>");
  for (const key of service.projectKeys()) {
    const project = config.projects[key]!;
    const record = service.projectRecord(key);
    const threadId = service.projectThread(key);
    const name = threadId
      ? `<a href="${topicLink(config.telegram.chatId, threadId)}">${escapeHtml(key)}</a>`
      : escapeHtml(key);
    const open = await service.store.countRequests(key, OPEN_PR_STATES);
    const topicNote = threadId
      ? ""
      : record?.topicError
        ? ` · 话题创建失败：${escapeHtml(record.topicError)}`
        : " · 话题未创建";
    const source = service.isPanelProject(key) ? " · 面板添加" : "";
    lines.push(`• ${name} · ${escapeHtml(project.repo)}${source} · 待合并 ${open}${topicNote}`);
  }
  return lines.join("\n");
}

async function projectStatus(service: HarnessService, key: string): Promise<string> {
  const view = service.projectView(key);
  if (!view) return `项目 ${escapeHtml(key)} 的配置无法解析`;
  const { config } = view;
  const record = service.projectRecord(key);
  const repo = config.project.repo;
  const lines = [
    `<b>${escapeHtml(key)}</b> · <a href="https://github.com/${escapeHtml(repo)}">${escapeHtml(repo)}</a>`,
    `默认分支：${escapeHtml(record?.defaultBranch ?? "未知")} · 类型：${config.policy.kind}`,
  ];
  if (!service.github?.available) lines.push("策略：GitHub App 未配置，使用默认值");
  else if (record?.policyError)
    lines.push(`⚠️ 策略读取失败，沿用上一版：${escapeHtml(record.policyError)}`);
  else if (record?.policy)
    lines.push(`策略：.cos/harness.yml @${escapeHtml((record.policySha ?? "").slice(0, 7))}`);
  else if (record?.inferredPolicy) lines.push("策略：默认分支没有 .cos/harness.yml，按仓库推断");
  else lines.push("策略：默认分支没有 .cos/harness.yml，使用默认值");
  if (view.overrideIssues) lines.push("⚠️ 覆盖层与当前配置冲突，已暂时忽略");
  const { result, machines, missing } = await lodyMachines(service, key);
  lines.push(renderExecutionLine(result, machines));
  if (missing.length > 0) lines.push(`未在 Lody 中找到：${escapeHtml(missing.join("、"))}`);
  const [queued, running, open] = await Promise.all([
    service.store.countRequests(key, WAITING_STATES),
    service.store.countRequests(key, ACTIVE_STATES),
    service.store.countRequests(key, OPEN_PR_STATES),
  ]);
  lines.push(`排队：${queued} · 进行中：${running} · 待合并 PR：${open}`);
  return lines.join("\n");
}

function parseSetArgs(args: string) {
  const ttlMatch = /\s--ttl\s+(\S+)\s*$/.exec(` ${args}`);
  const rest = ttlMatch ? ` ${args}`.slice(0, ttlMatch.index).trim() : args.trim();
  const space = rest.search(/\s/);
  if (space === -1) return null;
  return {
    path: rest.slice(0, space),
    valueText: rest.slice(space + 1).trim(),
    ttl: ttlMatch?.[1],
  };
}

function scopeFor(projectKey: string | undefined) {
  return projectKey ?? GLOBAL_SCOPE;
}

function scopeLabel(projectKey: string | undefined) {
  return projectKey ? `项目 ${escapeHtml(projectKey)}` : "全局";
}

function validateOverrides(
  service: HarnessService,
  next: readonly HarnessOverride[],
): ConfigIssue[] {
  const loaded = service.loadedConfig!;
  const now = service.now();
  const panel = executionLayerData(service.panelExecutionSetting);
  const global = resolveGlobalConfig(loaded.raw, next, now, panel);
  if (!global.ok) return global.issues;
  for (const key of service.projectKeys()) {
    const project = resolveProjectConfig(service.projectInput(key, next));
    if (!project.ok) return project.issues;
  }
  return [];
}

async function setOverride(
  service: HarnessService,
  request: HarnessCommandRequest,
  projectKey: string | undefined,
  args: string,
): Promise<HarnessReply> {
  const parsed = parseSetArgs(args);
  if (!parsed) return html("用法：/harness set &lt;路径&gt; &lt;值&gt; [--ttl 1d]");
  const segments = splitPath(parsed.path);
  if (!segments) return html("路径只能由字母、数字、- 和 _ 组成，并用 . 分隔");
  if (isLockedPath(segments)) {
    return html(`<code>${escapeHtml(parsed.path)}</code> 属于安全字段，只能通过 harness.yaml 修改`);
  }
  if (!projectKey && (segments[0] === "policy" || segments[0] === "project")) {
    return html("仓库策略字段请在对应项目话题中设置");
  }
  const ttlMs = parsed.ttl ? parseDuration(parsed.ttl) : null;
  if (parsed.ttl && ttlMs === null) return html("--ttl 格式应为 30s、45m、6h 或 7d");
  let value: unknown;
  try {
    value = parseYaml(parsed.valueText);
  } catch {
    return html("值不是合法的 YAML 标量或行内结构");
  }
  const now = service.now();
  const override: HarnessOverride = {
    scope: scopeFor(projectKey),
    path: segments.join("."),
    value,
    expiresAt: ttlMs ? new Date(now.getTime() + ttlMs) : null,
    actorId: request.userId,
    updatedAt: now,
  };
  const next = [
    ...service.overrideList.filter(
      (o) => !(o.scope === override.scope && o.path === override.path),
    ),
    override,
  ];
  const issues = validateOverrides(service, next);
  if (issues.length > 0) return html(renderIssues("覆盖未写入：校验失败", issues));
  await service.store.putOverride(override);
  service.setOverrides(next);
  await service.recordEvent({
    type: "config.override_set",
    projectKey: projectKey ?? null,
    actorId: request.userId,
    payload: { path: override.path, value, ttl: parsed.ttl ?? null },
  });
  const expiry = override.expiresAt
    ? `，${formatDateTime(override.expiresAt, service.globalView().config.telegram.notify.timezone)} 到期后恢复`
    : "";
  return html(
    `已写入${scopeLabel(projectKey)}覆盖：<code>${escapeHtml(override.path)}</code> = <code>${escapeHtml(
      JSON.stringify(value),
    )}</code>${expiry}`,
  );
}

async function unsetOverride(
  service: HarnessService,
  request: HarnessCommandRequest,
  projectKey: string | undefined,
  path: string,
): Promise<HarnessReply> {
  const segments = splitPath(path.trim());
  if (!segments) return html("用法：/harness unset &lt;路径&gt;");
  const scope = scopeFor(projectKey);
  const normalized = segments.join(".");
  const removed = await service.store.deleteOverride(scope, normalized);
  if (!removed)
    return html(`${scopeLabel(projectKey)}没有覆盖 <code>${escapeHtml(normalized)}</code>`);
  service.setOverrides(
    service.overrideList.filter((o) => !(o.scope === scope && o.path === normalized)),
  );
  await service.recordEvent({
    type: "config.override_unset",
    projectKey: projectKey ?? null,
    actorId: request.userId,
    payload: { path: normalized },
  });
  return html(`已删除${scopeLabel(projectKey)}覆盖 <code>${escapeHtml(normalized)}</code>`);
}

function scopedView(service: HarnessService, projectKey: string | undefined) {
  return projectKey ? service.projectView(projectKey) : service.globalView();
}

function diff(service: HarnessService, projectKey: string | undefined): HarnessReply {
  const view = scopedView(service, projectKey);
  if (!view) return html("配置无法解析");
  const baseline = mergeLayers(view.layers.filter((layer) => !layer.name.startsWith("override:")));
  const now = service.now();
  const scopes = projectKey ? [GLOBAL_SCOPE, projectKey] : [GLOBAL_SCOPE];
  const entries = scopes.flatMap((scope) => activeOverrides(service.overrideList, scope, now));
  if (entries.length === 0) return html(`${scopeLabel(projectKey)}没有生效的覆盖`);
  const timeZone = service.globalView().config.telegram.notify.timezone;
  const lines = [`<b>覆盖层差异</b>（${scopeLabel(projectKey)}）`];
  for (const entry of entries) {
    const segments = entry.path.split(".");
    const yamlValue = getPath(baseline, segments);
    lines.push(
      `• <code>${escapeHtml(entry.path)}</code>${entry.scope === GLOBAL_SCOPE && projectKey ? "（全局）" : ""}：${
        yamlValue === undefined ? "默认" : escapeHtml(JSON.stringify(yamlValue))
      } → <b>${escapeHtml(JSON.stringify(entry.value))}</b>${
        entry.expiresAt ? ` · ${formatDateTime(entry.expiresAt, timeZone)} 到期` : ""
      }`,
    );
  }
  if (view.overrideIssues) {
    lines.push("", renderIssues("以下覆盖与当前配置冲突，已暂时忽略", view.overrideIssues));
  }
  return html(lines.join("\n"));
}

function exportDocument(service: HarnessService, projectKey: string | undefined): HarnessReply {
  const view = scopedView(service, projectKey);
  if (!view) return html("配置无法解析");
  const stamp = formatDateTime(service.now(), service.globalView().config.telegram.notify.timezone);
  const content = `# Dev Harness 生效配置（${projectKey ?? "全局"}），导出于 ${stamp}\n${toYaml(view.config)}\n`;
  return {
    html: `${scopeLabel(projectKey)}生效配置`,
    document: { filename: `${projectKey ?? "harness"}.effective.yaml`, content },
  };
}

function showConfig(
  service: HarnessService,
  projectKey: string | undefined,
  path: string,
): HarnessReply {
  const view = scopedView(service, projectKey);
  if (!view) return html("配置无法解析");
  if (!path) {
    const text = toYaml(view.config);
    if (text.length > MESSAGE_LIMIT - 200) return exportDocument(service, projectKey);
    return html(`<b>${scopeLabel(projectKey)}生效配置</b>\n<pre>${escapeHtml(text)}</pre>`);
  }
  const segments = splitPath(path);
  if (!segments) return html("路径格式不正确");
  const value = getPath(view.config, segments);
  if (value === undefined) return html(`未找到字段 <code>${escapeHtml(path)}</code>`);
  const rendered = renderConfigValue(path, value, sourceOf(view.layers, segments));
  return rendered.length > MESSAGE_LIMIT ? exportDocument(service, projectKey) : html(rendered);
}

async function harnessSubcommand(
  service: HarnessService,
  request: HarnessCommandRequest,
  projectKey: string | undefined,
): Promise<HarnessReply> {
  const [subcommand = "", ...restParts] = request.args.split(/\s+/);
  const rest = request.args.slice(subcommand.length).trim();
  switch (subcommand.toLowerCase()) {
    case "config":
      return showConfig(service, projectKey, restParts[0] ?? "");
    case "set":
      return setOverride(service, request, projectKey, rest);
    case "unset":
      return unsetOverride(service, request, projectKey, rest);
    case "diff":
      return diff(service, projectKey);
    case "export":
      return exportDocument(service, projectKey);
    case "reload": {
      const result = await service.reload(request.userId);
      if (!result.ok) return html(renderIssues("reload 失败，继续使用上一次配置", result.issues));
      return html(
        `已重新加载 ${escapeHtml(basename(service.configFilePath))}，项目 ${service.projectKeys().length} 个`,
      );
    }
    default:
      return withManageButton(service, request, HARNESS_USAGE);
  }
}
