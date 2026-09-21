export type ToolEffectClass = "read_only" | "visible" | "mutating";

export interface ToolDescriptor {
  name: string;
  /** Telegram status line shown while the tool runs; undefined = no status line. */
  statusLabel?: string;
  /**
   * read_only: safe to replay, never counts as an effect.
   * visible: produced a user-visible or durable side effect; the turn must not be replayed.
   * mutating: unknown or non-visible external mutation (default for tools not listed).
   */
  effect: ToolEffectClass;
  /** Per-request call budget for this tool; undefined = only the global budget applies. */
  callLimit?: number;
  /**
   * Present when repeated calls with equal keys within a request return the cached result.
   * Returns the key suffix; `getToolCacheKey` prefixes the tool name.
   */
  cacheKey?: (args: Record<string, unknown>) => string;
}

const TWITTER_HOSTS = new Set([
  "twitter.com",
  "x.com",
  "vxtwitter.com",
  "fxtwitter.com",
  "api.vxtwitter.com",
  "api.fxtwitter.com",
  "fixvx.com",
]);
const TWITTER_STATUS_RE = /\/[^/]+\/status\/(\d+)/;
const PIXIV_ARTWORKS_RE = /\/(?:en\/)?(?:artworks|i)\/(\d+)/;

/** Normalize URLs for cache deduplication. */
export function normalizeUrlForCache(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // Twitter variants → tweet:{postId}
    if (TWITTER_HOSTS.has(host) || host.endsWith(".twitter.com") || host.endsWith(".x.com")) {
      const m = u.pathname.match(TWITTER_STATUS_RE);
      if (m) return `tweet:${m[1]}`;
    }

    // Pixiv
    if (host === "www.pixiv.net" || host === "pixiv.net") {
      const m = u.pathname.match(PIXIV_ARTWORKS_RE);
      if (m) return `pixiv:${m[1]}`;
    }

    // Generic: host + pathname (strip tracking params)
    return `${host}${u.pathname}`;
  } catch {
    return url.toLowerCase();
  }
}

const urlCacheKey = (args: Record<string, unknown>) => normalizeUrlForCache(String(args.url ?? ""));
const queryCacheKey = (args: Record<string, unknown>) =>
  String(args.query ?? "")
    .toLowerCase()
    .trim();

export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  // Memory tools
  { name: "get_profile", statusLabel: "🔍 看看你是谁...", effect: "read_only" },
  { name: "update_profile", statusLabel: "📝 记住你的变化...", effect: "mutating" },
  { name: "search_profiles", statusLabel: "🔎 想想这个人...", effect: "read_only" },
  { name: "search_history", statusLabel: "📜 翻翻聊天记录...", effect: "read_only" },
  // Telegram tools
  { name: "send_photo", statusLabel: "📷 发送图片...", effect: "visible" },
  { name: "send_voice", statusLabel: "🎙️ 发送语音...", effect: "visible" },
  { name: "send_document", statusLabel: "📎 发送文件...", effect: "visible" },
  { name: "send_poll", statusLabel: "📊 发起投票...", effect: "visible" },
  { name: "send_choice", statusLabel: "🎮 发送选择...", effect: "visible" },
  { name: "close_poll", statusLabel: "📊 关闭投票...", effect: "visible" },
  { name: "set_timer", statusLabel: "⏱️ 设置定时器...", effect: "visible" },
  { name: "cancel_timer", statusLabel: "⏱️ 取消定时器...", effect: "visible" },
  { name: "send_dice", statusLabel: "🎲 掷骰子...", effect: "visible" },
  { name: "edit_own_message", statusLabel: "✏️ 编辑消息...", effect: "visible" },
  { name: "delete_own_message", statusLabel: "🗑️ 撤回消息...", effect: "visible" },
  { name: "pin_message", statusLabel: "📌 置顶消息...", effect: "visible" },
  { name: "get_chat_info", statusLabel: "ℹ️ 获取聊天信息...", effect: "read_only" },
  { name: "reply_to_specific", statusLabel: "↩️ 回复消息...", effect: "visible" },
  // Web tools
  {
    name: "web_search",
    statusLabel: "🌐 搜索中...",
    effect: "read_only",
    callLimit: 64,
    cacheKey: queryCacheKey,
  },
  {
    name: "fetch_webpage",
    statusLabel: "📄 看看这个网页...",
    effect: "read_only",
    callLimit: 128,
    cacheKey: urlCacheKey,
  },
  {
    name: "search_danbooru_character_tags",
    statusLabel: "🏷️ 查找角色标签...",
    effect: "mutating",
    callLimit: 64,
  },
  {
    name: "search_generation_characters",
    statusLabel: "🔎 查找角色库...",
    effect: "mutating",
    callLimit: 64,
  },
  { name: "save_original_character", statusLabel: "📝 保存原创角色...", effect: "mutating" },
  {
    name: "delete_generation_character",
    statusLabel: "🗑️ 删除角色...",
    effect: "mutating",
  },
  { name: "get_character_bindings", statusLabel: "🔍 查看角色绑定...", effect: "read_only" },
  { name: "set_character_binding", statusLabel: "🔗 绑定角色...", effect: "mutating" },
  {
    name: "remove_character_binding",
    statusLabel: "🔗 解除角色绑定...",
    effect: "mutating",
  },
  { name: "search_prompt_assets", statusLabel: "🔎 查找提示词资产...", effect: "read_only" },
  { name: "save_prompt_asset", statusLabel: "📝 保存提示词资产...", effect: "mutating" },
  { name: "delete_prompt_asset", statusLabel: "🗑️ 删除提示词资产...", effect: "mutating" },
  { name: "get_current_time", statusLabel: "🕐 获取时间...", effect: "read_only" },
  { name: "generate_image", statusLabel: "🎨 画画中...", effect: "mutating" },
  { name: "github_repository", statusLabel: "🐙 查看 GitHub 仓库...", effect: "read_only" },
  { name: "github_read_file", statusLabel: "🐙 读取仓库代码...", effect: "read_only" },
  { name: "github_list_tree", statusLabel: "🐙 查看代码结构...", effect: "read_only" },
  { name: "github_list_issues", statusLabel: "🐙 查看 Issue...", effect: "read_only" },
  { name: "github_code_task", statusLabel: "🛠️ Pi 正在修改和测试代码...", effect: "mutating" },
  {
    name: "github_inspect_workspace",
    statusLabel: "🔎 检查本地 coding workspace...",
    effect: "read_only",
  },
  {
    name: "github_resume_workspace",
    statusLabel: "🔐 准备 workspace 恢复确认...",
    effect: "mutating",
  },
  {
    name: "github_discard_workspace",
    statusLabel: "🔐 准备 workspace 丢弃确认...",
    effect: "mutating",
  },
  { name: "github_push_branch", statusLabel: "🔐 准备分支推送确认...", effect: "mutating" },
  {
    name: "github_create_pull_request",
    statusLabel: "🔐 准备 Pull Request 创建确认...",
    effect: "mutating",
  },
  { name: "github_create_issue", statusLabel: "🔐 准备 Issue 创建确认...", effect: "mutating" },
  { name: "github_update_issue", statusLabel: "🔐 准备 Issue 更新确认...", effect: "mutating" },
  // Agent tools
  { name: "delegate_task", statusLabel: "🤖 找帮手...", effect: "read_only", callLimit: 64 },
  // Bot memory tools
  { name: "save_memory", statusLabel: "💾 记下来...", effect: "mutating" },
  { name: "recall_memories", statusLabel: "🧠 回忆中...", effect: "read_only" },
  { name: "delete_memory", statusLabel: "🗑️ 忘掉它...", effect: "mutating" },
  // Artwork tools
  {
    name: "fetch_artwork_info",
    statusLabel: "🖼️ 查看作品...",
    effect: "read_only",
    callLimit: 64,
    cacheKey: urlCacheKey,
  },
  { name: "send_artwork", statusLabel: "🖼️ 发送作品图片...", effect: "visible" },
  { name: "send_media_group", statusLabel: "📷 发送多张图片...", effect: "visible" },
  // File tools
  { name: "read_file", statusLabel: "📄 读取文件...", effect: "read_only" },
  { name: "write_file", statusLabel: "✏️ 写入文件...", effect: "mutating" },
  { name: "delete_file", statusLabel: "🗑️ 删除文件...", effect: "mutating" },
  { name: "save_received_file", statusLabel: "💾 保存文件...", effect: "mutating" },
  // Tools without a status line
  { name: "react_to_message", effect: "visible" },
  { name: "send_sticker", effect: "visible" },
  { name: "set_mood", effect: "visible" },
  { name: "create_image", effect: "visible" },
  { name: "cancel_image_generation", effect: "visible" },
  { name: "check_rss", effect: "read_only" },
  { name: "list_rss_feeds", effect: "read_only" },
  { name: "list_image_presets", effect: "read_only" },
  { name: "get_image_generation", effect: "read_only" },
];

const DESCRIPTOR_BY_NAME = new Map<string, ToolDescriptor>();
for (const descriptor of TOOL_DESCRIPTORS) {
  if (DESCRIPTOR_BY_NAME.has(descriptor.name)) {
    throw new Error(`Duplicate tool descriptor: ${descriptor.name}`);
  }
  DESCRIPTOR_BY_NAME.set(descriptor.name, descriptor);
}

export function getToolDescriptor(name: string): ToolDescriptor | undefined {
  return DESCRIPTOR_BY_NAME.get(name);
}

export function getToolStatusLabel(name: string): string | undefined {
  return DESCRIPTOR_BY_NAME.get(name)?.statusLabel;
}

export function isReadOnlyTool(name: string): boolean {
  return DESCRIPTOR_BY_NAME.get(name)?.effect === "read_only";
}

export function hasVisibleToolEffect(name: string): boolean {
  return DESCRIPTOR_BY_NAME.get(name)?.effect === "visible";
}

export function getToolCallLimit(name: string): number | undefined {
  return DESCRIPTOR_BY_NAME.get(name)?.callLimit;
}

export function getToolCacheKey(name: string, args: Record<string, unknown>): string | undefined {
  const cacheKey = DESCRIPTOR_BY_NAME.get(name)?.cacheKey;
  return cacheKey ? `${name}:${cacheKey(args)}` : undefined;
}

function namesWithEffect(effect: ToolEffectClass): ReadonlySet<string> {
  return new Set(TOOL_DESCRIPTORS.filter((d) => d.effect === effect).map((d) => d.name));
}

/** Derived name sets kept for callers that iterate; contents equal the former literal Sets. */
export const VISIBLE_EFFECT_TOOL_NAMES: ReadonlySet<string> = namesWithEffect("visible");
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = namesWithEffect("read_only");
