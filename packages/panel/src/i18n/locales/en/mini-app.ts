export const miniApp = {
  brand: { eyebrow: "Telegram control deck", name: "Hagoromo" },
  language: "Language",
  help: {
    eyebrow: "A calmer way to run your Bot",
    title: "Your Telegram companion, explained.",
    intro:
      "Hagoromo brings COS Tool Bot's useful commands and carefully scoped controls into Telegram. Public help stays available even when the control plane is offline.",
    privacyTitle: "Privacy by boundary",
    privacyBody:
      "Panel access is separate from AI allowlists. This page never reveals providers, runtime status, credentials, or private group data.",
    commandsTitle: "Commands you can rely on",
    commandsIntro: "These public commands come from the same catalog used by the Bot.",
    commandLabel: "Telegram command /{{command}}",
    projectTitle: "Why this project exists",
    projectBody:
      "COS Tool Bot is a self-hosted, multi-Bot assistant toolkit. Hagoromo keeps everyday help close while reserving consequential changes for explicitly trusted people.",
  },
  categories: {
    general: "Essentials",
    conversation: "Conversation",
    ai: "AI",
    operations: "Operations",
    privacy: "Privacy",
    media: "Media",
    integrations: "Integrations",
  },
  nav: { groups: "Groups", settings: "Settings", access: "Access", help: "Help" },
  session: {
    loading: "Verifying your Telegram session…",
    expiredTitle: "Session expired",
    expiredBody: "Close this page and open the Mini App from the Bot again.",
    forbiddenTitle: "This area is not available",
    unavailableTitle: "Control plane unavailable",
    unavailableBody: "Help is still available while the connection recovers.",
    openHelp: "Open public help",
  },
  placeholder: {
    groupsTitle: "Groups are next",
    groupsBody: "The access-aware group directory arrives in G3–G4.",
    settingsTitle: "Settings are next",
    settingsBody: "Lifecycle and common Bot settings arrive after the shared services are ready.",
    accessTitle: "Access is next",
    accessBody: "Grant management arrives in G3. No placeholder action changes data.",
  },
} as const;
