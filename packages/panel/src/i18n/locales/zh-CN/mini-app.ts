export const miniApp = {
  brand: { eyebrow: "Telegram 控制舱", name: "羽衣" },
  language: "语言",
  help: {
    eyebrow: "更从容地使用你的 Bot",
    title: "先认识羽衣，再开始操作。",
    intro:
      "羽衣把 COS Tool Bot 的常用命令和经过严格授权的管理能力带进 Telegram。即使控制服务暂时离线，公共帮助仍然可以阅读。",
    privacyTitle: "权限边界就是隐私边界",
    privacyBody:
      "面板权限与 AI 白名单完全独立。此页面不会透露 Provider、运行状态、凭据或私有群组数据。",
    commandsTitle: "随时可用的命令",
    commandsIntro: "以下公共命令与 Bot 运行时使用同一份目录，不再维护两套说明。",
    commandLabel: "Telegram 命令 /{{command}}",
    projectTitle: "为什么做这个项目",
    projectBody:
      "COS Tool Bot 是一个可自托管、多 Bot 的助手机器人工具箱。羽衣让日常帮助触手可及，同时把重要操作只交给被明确授权的人。",
  },
  categories: {
    general: "常用",
    conversation: "对话",
    ai: "AI",
    operations: "运维",
    privacy: "隐私",
    media: "媒体",
    integrations: "集成",
  },
  nav: { groups: "群组", settings: "设置", access: "权限", help: "帮助" },
  session: {
    loading: "正在验证 Telegram 会话…",
    expiredTitle: "会话已过期",
    expiredBody: "请关闭此页面，然后从 Bot 重新打开小程序。",
    forbiddenTitle: "你不能访问此区域",
    unavailableTitle: "控制服务暂不可用",
    unavailableBody: "连接恢复前，公共帮助仍然可以正常查看。",
    openHelp: "打开公共帮助",
  },
  placeholder: {
    groupsTitle: "群组功能即将接入",
    groupsBody: "带权限投影的群目录将在 G3–G4 交付。",
    settingsTitle: "设置功能即将接入",
    settingsBody: "生命周期和常用 Bot 设置会在共享服务就绪后开放。",
    accessTitle: "权限管理即将接入",
    accessBody: "Grant 管理将在 G3 交付；当前占位页不会修改任何数据。",
  },
} as const;
