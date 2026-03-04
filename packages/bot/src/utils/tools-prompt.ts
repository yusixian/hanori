import { getArtworkPlatforms } from "../tools/index.js";

export interface ExtendedToolsPromptOptions {
  hasStickerPacks: boolean;
  hasTTS: boolean;
  hasWebTools: boolean;
  hasSearchTool: boolean;
  hasImageGeneration: boolean;
  imageGenerationProvider?: string;
  hasAgentTools: boolean;
  availableAgents: string[];
  hasBotMemory: boolean;
  hasArtworkTools: boolean;
  hasFileTools: boolean;
  isPrivate: boolean;
  hasMultiMessage: boolean;
}

export function buildExtendedToolsPrompt(opts: ExtendedToolsPromptOptions): string {
  const lines: string[] = [];

  // Behavior tools (always available)
  lines.push("你拥有以下高级行为工具:");
  if (opts.hasMultiMessage) {
    lines.push("- multi_message: 分多条消息回复（像真人那样）。使用后不需要再生成普通文本回复。");
  }
  lines.push("- set_mood: 设置你的情绪状态，影响后续回复语气。");

  // Telegram interaction tools
  lines.push("");
  lines.push("Telegram 互动工具:");
  lines.push(
    "- react_to_message: 对当前消息添加 emoji 表情回应。只能使用 Telegram 允许的 emoji: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡",
  );
  if (opts.hasStickerPacks) {
    lines.push("- send_sticker: 发送一个贴纸来表达情绪");
  }
  lines.push(
    "- send_photo: 发送图片（URL、file_id，或 local:photo.png 发送 data 目录文件）。支持 has_spoiler 遮罩",
  );
  if (opts.hasTTS) {
    lines.push("- send_voice: 发送语音消息（文本转语音）");
  }
  lines.push("- send_document: 发送文件（URL、file_id，或 local:report.csv 发送 data 目录文件）");
  lines.push("- send_media_group: 批量发送多张图片或文档（支持 URL、file_id、local:xxx 混合）");
  lines.push("- send_poll: 发起投票（非匿名时投票结果会自动通知你）");
  lines.push("- send_choice: 发送 inline keyboard 选择按钮（用户点击后你会自动收到通知）");
  lines.push("- close_poll: 手动关闭投票并获取最终结果");
  lines.push("- set_timer: 设置定时器，到期后你会自动收到通知继续对话");
  lines.push("- cancel_timer: 取消定时器");
  lines.push("- send_dice: 发送骰子/随机动画");
  lines.push("- edit_own_message: 编辑 bot 之前发的消息");
  lines.push("- delete_own_message: 删除/撤回 bot 之前发的消息");
  lines.push("- pin_message: 置顶消息（需管理员权限）");
  lines.push("- get_chat_info: 获取当前聊天信息");
  lines.push("- reply_to_specific: 回复某条特定历史消息");

  // Web tools
  if (opts.hasWebTools) {
    lines.push("");
    lines.push("信息获取工具:");
    lines.push("- get_current_time: 获取当前时间");
    if (opts.hasSearchTool) {
      lines.push("- web_search: 搜索网络获取最新信息");
    }
    lines.push("- fetch_webpage: 获取网页正文内容");
    if (opts.hasImageGeneration) {
      if (opts.imageGenerationProvider === "pixai") {
        lines.push(
          "- generate_image: 使用指定 AI 模型生成高质量 AI 图片，图片会在后台生成完成后自动发送到聊天。提示词支持自然语言描述，编写时必须保留用户明确指定的重要特征（正字计数、特定文字、具体姿势、服装细节等），不要擅自省略或改写。用户处于简体中文环境，涉及文字内容时默认简体中文。",
        );
        lines.push(
          "  **提示词质量要求**: 不要只写简单的主体描述，要主动补充专业细节让画面精彩出众。包括但不限于: 光影效果（逆光、黄金时段光、丁达尔效应、霓虹灯光等）、构图方式（特写、仰视、俯瞰、三分法、对角线构图等）、氛围与主题（季节感、情绪基调、叙事感等）、画面细节（材质质感、环境元素、色彩搭配、景深虚化等）。让每张图都能充分展现模型的表现力。",
        );
        if (opts.hasBotMemory) {
          lines.push(
            "  **画用户相关图片时**: 当用户要求画「对我的印象」「我的形象」「画我」等涉及用户本人的图片时，先用 recall_memories 搜索关于该用户的记忆（外貌特征、性格印象、过往互动细节等），结合已知的用户信息，将这些印象汇总提炼后再编写提示词生成图片，让画面真正体现你对这个人的了解和印象。",
          );
        }
      } else {
        lines.push("- generate_image: AI 生成图片，配合 send_photo 发送");
      }
    }
  }

  // Agent tools
  if (opts.hasAgentTools && opts.availableAgents.length > 0) {
    lines.push("");
    lines.push("子任务委派工具:");
    lines.push(
      `- delegate_task: 将复杂任务委派给专门的 agent (${opts.availableAgents.join(", ")})`,
    );
  }

  // File tools
  if (opts.hasFileTools) {
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
  if (opts.hasBotMemory) {
    lines.push("");
    lines.push("长期记忆工具:");
    lines.push("- save_memory: 保存一条长期记忆（通用或关联特定用户）");
    lines.push("- recall_memories: 搜索已保存的记忆");
    lines.push("- delete_memory: 删除不再需要的记忆");
  }

  // Artwork tools
  if (opts.hasArtworkTools) {
    const platforms = getArtworkPlatforms();
    lines.push("");
    lines.push(`作品图片抓取工具（支持: ${platforms.join(", ")}）:`);
    lines.push("- fetch_artwork_info: 从 URL 获取作品信息（标题、作者、图片列表、标签等）");
    lines.push("- send_artwork: 发送作品图片（支持单图/多图、NSFW 遮罩）");
    lines.push("");
    lines.push("**重要 — 作品链接自动处理规则:**");
    lines.push(
      "- 当用户消息中包含 pixiv.net/artworks/、twitter.com/.../status/、x.com/.../status/ 等链接时，**必须**立即调用 fetch_artwork_info 获取作品信息",
    );
    lines.push("- 获取成功后**必须**调用 send_artwork 发送图片给用户");
    lines.push(
      "- 不要对这些链接使用 fetch_webpage，fetch_artwork_info 能获取更完整的结构化信息和图片",
    );
    lines.push("- 对 NSFW/R18 内容开启 has_spoiler 遮罩");
    lines.push("- 发完图片后可以用自然语言评论作品");
    lines.push(
      "- fetch_artwork_info 成功后直接 send_artwork，**不要**再用 fetch_webpage/web_search 获取同一作品",
    );
    lines.push(
      "- 如果 fetch_artwork_info 返回 imageCount: 0，说明该推文没有可发送的图片，直接文字描述即可",
    );
  }

  lines.push("");
  lines.push("使用指南:");
  lines.push("- 积极使用互动工具让对话更生动，像真人聊天一样自然表达");
  if (opts.hasMultiMessage) {
    lines.push("- 除非使用了 multi_message，否则你必须生成文字回复内容");
  } else {
    lines.push("- 你必须生成文字回复内容");
  }
  lines.push("- 遇到需要分析或规划的问题时，先在回复前整理思路");
  lines.push("- 避免对同一内容反复调用不同工具，每次工具调用前先检查是否已有足够信息");
  lines.push("");
  lines.push("**主动行为建议**:");
  lines.push("- 用户说了有趣/感动/搞笑的话 → react_to_message 加个表情");
  if (opts.hasMultiMessage) {
    lines.push("- 回复内容较长或包含多个话题 → 用 multi_message 分条发送");
  }
  lines.push("- 对话氛围变化时 → 用 set_mood 调整情绪状态");
  lines.push("- 用户分享了个人信息 → 用记忆工具记录");
  if (opts.hasSearchTool) {
    lines.push("- 用户提到时事/不确定的事实 → 用 web_search 查证");
  }
  lines.push("- 需要用户做选择时 → 用 send_choice 或 send_poll，禁止文本选数字");
  lines.push("");
  lines.push("**选择交互规则（重要）**:");
  lines.push(
    "- 当你需要让用户做选择（如 galgame 剧情分支、多选一问答、互动游戏选项等），**禁止**在文本中用「1. 2. 3. 选数字」的方式，必须使用交互工具：",
  );
  if (opts.isPrivate) {
    lines.push("  - 当前为私聊：使用 send_choice 发送 inline keyboard 按钮让用户点选");
  } else {
    lines.push("  - 当前为群聊：使用 send_poll 发起投票让群成员投票选择");
    lines.push(
      "  - 如果选项仅面向特定用户而非群体决策，也可以使用 send_choice 并指定 target_user_id",
    );
  }
  lines.push("- 你可以先用文字描述选项内容/背景，然后紧跟 send_choice 或 send_poll 工具调用");

  return lines.join("\n");
}
