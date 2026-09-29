import { getArtworkPlatforms } from "../tools/index.js";
import type { ToolPromptCapability } from "./tool-capabilities.js";

export interface ExtendedToolsPromptOptions {
  capabilities: ReadonlySet<ToolPromptCapability>;
  availableAgents: string[];
  isPrivate: boolean;
  /** Effective set_timer ceiling, in seconds. Must match the tool schema. */
  timerMaxSeconds: number;
}

export function buildExtendedToolsPrompt(opts: ExtendedToolsPromptOptions): string {
  const lines: string[] = [];

  // Behavior tools (always available)
  lines.push("你拥有以下高级行为工具:");
  if (opts.capabilities.has("multi-message")) {
    lines.push(
      "- multi_message: 分多条消息回复（像真人那样）。同一请求可在不同阶段发送不同内容，但不要重复相同内容；使用后不需要再生成普通文本回复。",
    );
  }
  lines.push("- set_mood: 设置你的情绪状态，影响后续回复语气。");

  // Telegram interaction tools
  lines.push("");
  lines.push("Telegram 互动工具:");
  lines.push(
    "- react_to_message: 对当前消息添加 emoji 表情回应。只能使用 Telegram 允许的 emoji: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡",
  );
  if (opts.capabilities.has("sticker")) {
    lines.push("- send_sticker: 发送一个贴纸来表达情绪");
  }
  lines.push(
    "- send_photo: 发送图片（URL、file_id，或 local:photo.png 发送 data 目录文件）。支持 has_spoiler 遮罩",
  );
  lines.push("- send_document: 发送文件（URL、file_id，或 local:report.csv 发送 data 目录文件）");
  lines.push("- send_media_group: 批量发送多张图片或文档（支持 URL、file_id、local:xxx 混合）");
  lines.push("- send_poll: 发起投票（非匿名时投票结果会自动通知你）");
  lines.push("- send_choice: 发送 inline keyboard 选择按钮（用户点击后你会自动收到通知）");
  lines.push("- close_poll: 手动关闭投票并获取最终结果");
  lines.push(
    `- set_timer: 设置定时器，到期后你会自动收到通知继续对话。单个定时器最长 ${opts.timerMaxSeconds} 秒`,
  );
  lines.push("- cancel_timer: 取消定时器");
  lines.push("- send_dice: 发送骰子/随机动画");
  lines.push("- edit_own_message: 编辑 bot 之前发的消息");
  lines.push("- delete_own_message: 删除/撤回 bot 之前发的消息");
  lines.push("- pin_message: 置顶消息（需管理员权限）");
  lines.push("- get_chat_info: 获取当前聊天信息");
  lines.push(
    "- reply_to_specific: 回复某条特定历史消息。reply_to_message_id 只接受上下文中 [#数字] 标注的 ID（包括对话历史和近期群聊消息），或本轮工具返回的刚发出消息 ID。没有 ID 标注的消息不要猜数字，改用普通回复",
  );

  // Web tools
  if (opts.capabilities.has("web")) {
    lines.push("");
    lines.push("信息获取工具:");
    lines.push("- get_current_time: 获取当前时间");
    if (opts.capabilities.has("web-search")) {
      lines.push("- web_search: 搜索网络获取最新信息");
    }
    lines.push("- fetch_webpage: 获取网页正文内容");
  }

  if (opts.capabilities.has("image-generation")) {
    lines.push("");
    lines.push("异步生图工具:");
    lines.push("- list_image_presets（可用时）: 创建前列出管理员允许的预设");
    lines.push(
      "- create_image（可用时）: 仅从工具参数枚举中的可用路由选择；anime_illustration 可用时为默认，且不得自动跨供应商降级",
    );
    lines.push("- get_image_generation / cancel_image_generation: 查询或请求取消任务");
    if (opts.capabilities.has("bot-memory")) {
      lines.push("- 画用户本人时，先检索相关长期记忆，再据此编写提示词");
    }
  }

  // Agent tools
  if (opts.capabilities.has("agent-delegation") && opts.availableAgents.length > 0) {
    lines.push("");
    lines.push("子任务委派工具:");
    lines.push(
      `- delegate_task: 将复杂任务委派给专门的 agent (${opts.availableAgents.join(", ")})`,
    );
  }

  // File tools
  if (opts.capabilities.has("file")) {
    lines.push("");
    lines.push("文件工具:");
    lines.push("- read_file: 读取你的 data 目录中的文件（如 NOTES.md、IDENTITY.md）");
    lines.push("- write_file: 写入文件到 data 目录（创建或覆盖）");
    lines.push("- delete_file: 删除 data 目录中的文件（临时文件用完记得删）");
    lines.push(
      "- save_received_file: 保存用户发来的文件/图片到 data/received 目录（之后可用 local:received/xxx 发送）",
    );
    lines.push("- 当用户发送文件或图片时，消息中会标注附件信息");
    lines.push("- 如果你判断需要保存该文件，应在当前回合立即调用 save_received_file");
    lines.push("- 只有管理员在面板中标记为「可注入」的 .md 文件才会被注入到 system prompt");
    lines.push("- 当你需要记录长期信息或更新自己的设定时，使用 write_file");
  }

  // Bot memory tools
  if (opts.capabilities.has("bot-memory")) {
    lines.push("");
    lines.push("长期记忆工具:");
    lines.push("- recall_memories: 搜索当前聊天可见的长期记忆");
    lines.push("- save_memory（可用时）: 有明确证据和长期价值时保存；无需记住每次个人信息披露");
    lines.push("- update_memory（可用时）: 纠正已有记忆或设置到期时间");
    lines.push("- retire_memory（可用时）: 停用过时、重复的记忆");
    lines.push("- delete_memory（仅在可用时）: 用户明确要求忘记时永久删除");
  }

  // Artwork tools
  if (opts.capabilities.has("artwork")) {
    const platforms = getArtworkPlatforms();
    lines.push("");
    lines.push(`作品图片抓取工具（支持: ${platforms.join(", ")}）:`);
    lines.push("- fetch_artwork_info: 从 URL 获取作品信息（标题、作者、图片列表、标签等）");
    lines.push("- send_artwork: 发送作品图片（支持单图/多图、NSFW 遮罩）");
    lines.push("");
    lines.push("作品链接:");
    lines.push(
      "- 用户消息里有 pixiv.net/artworks/、twitter.com/.../status/、x.com/.../status/ 等作品链接时，用 fetch_artwork_info 获取作品信息，再用 send_artwork 把图片发给用户",
    );
    lines.push("- 对 NSFW/R18 内容开启 has_spoiler 遮罩");
    lines.push("- 发完图片后可以用自然语言评论作品");
  }

  lines.push("");
  lines.push("使用指南:");
  if (opts.capabilities.has("multi-message")) {
    lines.push("- 除非使用了 multi_message，否则你必须生成文字回复内容");
  } else {
    lines.push("- 你必须生成文字回复内容");
  }
  lines.push("- 避免对同一内容反复调用不同工具，每次工具调用前先检查是否已有足够信息");
  lines.push("");
  lines.push("选择交互:");
  lines.push(
    "- 需要用户做选择时（如 galgame 剧情分支、多选一问答、互动游戏选项），用交互工具代替文本里的「1. 2. 3.」选项，这样用户的选择会作为事件回到对话里：",
  );
  if (opts.isPrivate) {
    lines.push("  - 当前为私聊：用 send_choice 发送 inline keyboard 按钮");
  } else {
    lines.push("  - 当前为群聊：用 send_poll 让群成员投票");
    lines.push("  - 选项只面向某位用户时，用 send_choice 并指定 target_user_id");
  }
  lines.push("- 可以先用文字交代选项背景，再调用 send_choice 或 send_poll");

  return lines.join("\n");
}
