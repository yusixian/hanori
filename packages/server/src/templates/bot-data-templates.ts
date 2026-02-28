export const BOT_DATA_TEMPLATES: Record<string, string> = {
  "IDENTITY.md": `# Identity

在这里定义 bot 的身份和角色设定。

例如：
- 你的名字是什么
- 你是什么身份（助手、朋友、角色扮演等）
- 你的基本背景故事
`,
  "SOUL.md": `# Soul

在这里定义 bot 的性格、语气和行为风格。

例如：
- 你的性格特征（活泼、沉稳、幽默等）
- 你的说话风格和语气
- 你对不同话题的态度
`,
  "NOTES.md": `# Notes

自由笔记区，bot 可在对话中通过 write_file 工具自行编辑记录。

这里可以存放：
- 重要事项的备忘
- 学到的新知识
- 需要长期记住的信息
`,
};
