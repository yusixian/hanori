/// <reference types="vite/client" />

export type TelegramColorScheme = "light" | "dark";

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
  bottom_bar_bg_color?: string;
  [name: string]: string | undefined;
}

export interface TelegramContentInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TelegramBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

export type TelegramWebAppEvent =
  | "themeChanged"
  | "viewportChanged"
  | "safeAreaChanged"
  | "contentSafeAreaChanged";

export interface TelegramWebApp {
  initData: string;
  colorScheme: TelegramColorScheme;
  themeParams: TelegramThemeParams;
  viewportHeight: number;
  viewportStableHeight: number;
  isExpanded: boolean;
  safeAreaInset: TelegramContentInsets;
  contentSafeAreaInset: TelegramContentInsets;
  BackButton: TelegramBackButton;
  ready(): void;
  expand(): void;
  onEvent(event: TelegramWebAppEvent, handler: () => void): void;
  offEvent(event: TelegramWebAppEvent, handler: () => void): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export interface TelegramMiniAppState {
  initData: string;
  colorScheme: TelegramColorScheme;
  themeParams: TelegramThemeParams;
  viewport: {
    height: number;
    stableHeight: number;
    isExpanded: boolean;
  };
  safeArea: TelegramContentInsets;
  contentSafeArea: TelegramContentInsets;
}

export interface TelegramMiniAppAdapter {
  readonly available: boolean;
  getSnapshot(): TelegramMiniAppState;
  subscribe(listener: () => void): () => void;
  ready(): void;
  expand(): void;
  setBackButton(handler: () => void): () => void;
}

const EVENTS: readonly TelegramWebAppEvent[] = [
  "themeChanged",
  "viewportChanged",
  "safeAreaChanged",
  "contentSafeAreaChanged",
];

const EMPTY_INSETS: TelegramContentInsets = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

const EMPTY_STATE: TelegramMiniAppState = Object.freeze({
  initData: "",
  colorScheme: "light",
  themeParams: Object.freeze({}),
  viewport: Object.freeze({ height: 0, stableHeight: 0, isExpanded: false }),
  safeArea: EMPTY_INSETS,
  contentSafeArea: EMPTY_INSETS,
});

const DEV_MOCK_STORAGE_KEY = "cos-tool-bot:telegram-mini-app-mock";

type CssVariableMap = Record<`--${string}`, string>;

function normalizeInsets(
  insets: Partial<TelegramContentInsets> | undefined,
): TelegramContentInsets {
  return {
    top: Number.isFinite(insets?.top) ? Number(insets?.top) : 0,
    right: Number.isFinite(insets?.right) ? Number(insets?.right) : 0,
    bottom: Number.isFinite(insets?.bottom) ? Number(insets?.bottom) : 0,
    left: Number.isFinite(insets?.left) ? Number(insets?.left) : 0,
  };
}

function readState(webApp: TelegramWebApp): TelegramMiniAppState {
  return {
    initData: webApp.initData || "",
    colorScheme: webApp.colorScheme === "dark" ? "dark" : "light",
    themeParams: { ...webApp.themeParams },
    viewport: {
      height: Number.isFinite(webApp.viewportHeight) ? webApp.viewportHeight : 0,
      stableHeight: Number.isFinite(webApp.viewportStableHeight) ? webApp.viewportStableHeight : 0,
      isExpanded: Boolean(webApp.isExpanded),
    },
    safeArea: normalizeInsets(webApp.safeAreaInset),
    contentSafeArea: normalizeInsets(webApp.contentSafeAreaInset),
  };
}

function stateCssVariables(state: TelegramMiniAppState): CssVariableMap {
  const variables: CssVariableMap = {
    "--tg-viewport-height": `${state.viewport.height}px`,
    "--tg-viewport-stable-height": `${state.viewport.stableHeight}px`,
    "--tg-safe-area-inset-top": `${state.safeArea.top}px`,
    "--tg-safe-area-inset-right": `${state.safeArea.right}px`,
    "--tg-safe-area-inset-bottom": `${state.safeArea.bottom}px`,
    "--tg-safe-area-inset-left": `${state.safeArea.left}px`,
    "--tg-content-safe-area-inset-top": `${state.contentSafeArea.top}px`,
    "--tg-content-safe-area-inset-right": `${state.contentSafeArea.right}px`,
    "--tg-content-safe-area-inset-bottom": `${state.contentSafeArea.bottom}px`,
    "--tg-content-safe-area-inset-left": `${state.contentSafeArea.left}px`,
  };

  for (const [name, value] of Object.entries(state.themeParams)) {
    if (value && /^[a-z][a-z0-9_]*$/.test(name)) {
      variables[`--tg-theme-${name.replaceAll("_", "-")}`] = value;
    }
  }

  return variables;
}

function applyRootVariables(
  root: HTMLElement,
  state: TelegramMiniAppState,
  previouslyApplied: Set<string>,
): void {
  const variables = stateCssVariables(state);

  for (const name of previouslyApplied) {
    if (!(name in variables)) root.style.removeProperty(name);
  }
  previouslyApplied.clear();

  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
    previouslyApplied.add(name);
  }
}

function readDevMockConfig(targetWindow: Window): Record<string, unknown> | undefined {
  const query = new URLSearchParams(targetWindow.location.search);
  let stored: Record<string, unknown> | undefined;

  try {
    const value = targetWindow.localStorage.getItem(DEV_MOCK_STORAGE_KEY);
    if (value) stored = JSON.parse(value) as Record<string, unknown>;
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }

  if (query.get("tgWebAppMock") !== "1" && stored?.enabled !== true) return undefined;

  return {
    ...stored,
    ...(query.has("tgWebAppColorScheme") ? { colorScheme: query.get("tgWebAppColorScheme") } : {}),
    ...(query.has("tgWebAppInitData") ? { initData: query.get("tgWebAppInitData") } : {}),
  };
}

function createDevMockWebApp(targetWindow: Window): TelegramWebApp | undefined {
  const config = readDevMockConfig(targetWindow);
  if (!config) return undefined;

  const colorScheme: TelegramColorScheme = config.colorScheme === "dark" ? "dark" : "light";
  const listeners = new Map<TelegramWebAppEvent, Set<() => void>>();
  const backHandlers = new Set<() => void>();
  const backButton: TelegramBackButton = {
    isVisible: false,
    show() {
      backButton.isVisible = true;
    },
    hide() {
      backButton.isVisible = false;
    },
    onClick(handler) {
      backHandlers.add(handler);
    },
    offClick(handler) {
      backHandlers.delete(handler);
    },
  };

  return {
    initData: typeof config.initData === "string" ? config.initData : "dev-telegram-init-data",
    colorScheme,
    themeParams:
      colorScheme === "dark"
        ? { bg_color: "#17212b", text_color: "#f5f5f5", secondary_bg_color: "#232e3c" }
        : { bg_color: "#ffffff", text_color: "#111111", secondary_bg_color: "#f1f1f1" },
    viewportHeight: targetWindow.innerHeight,
    viewportStableHeight: targetWindow.innerHeight,
    isExpanded: true,
    safeAreaInset: { ...EMPTY_INSETS },
    contentSafeAreaInset: { ...EMPTY_INSETS },
    BackButton: backButton,
    ready() {},
    expand() {},
    onEvent(event, handler) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(handler);
      listeners.set(event, eventListeners);
    },
    offEvent(event, handler) {
      listeners.get(event)?.delete(handler);
    },
  };
}

function resolveTelegramWebApp(targetWindow: Window | undefined): TelegramWebApp | undefined {
  const webApp = targetWindow?.Telegram?.WebApp;
  if (webApp) return webApp;
  if (!targetWindow || !import.meta.env.DEV) return undefined;

  return createDevMockWebApp(targetWindow);
}

export function createTelegramMiniAppAdapter(root: HTMLElement): TelegramMiniAppAdapter {
  const targetWindow = typeof window === "undefined" ? undefined : window;
  const webApp = resolveTelegramWebApp(targetWindow);
  if (!webApp) {
    return {
      available: false,
      getSnapshot: () => EMPTY_STATE,
      subscribe: () => () => {},
      ready() {},
      expand() {},
      setBackButton: () => () => {},
    };
  }

  const listeners = new Set<() => void>();
  const appliedVariables = new Set<string>();
  let snapshot = readState(webApp);
  let subscribedToWebApp = false;
  let backRegistration: { handler: () => void } | undefined;

  const refresh = () => {
    snapshot = readState(webApp);
    applyRootVariables(root, snapshot, appliedVariables);
    for (const listener of listeners) listener();
  };

  const subscribeToWebApp = () => {
    if (subscribedToWebApp) return;
    for (const event of EVENTS) webApp.onEvent(event, refresh);
    subscribedToWebApp = true;
  };

  const unsubscribeFromWebApp = () => {
    if (!subscribedToWebApp) return;
    for (const event of EVENTS) webApp.offEvent(event, refresh);
    subscribedToWebApp = false;
  };

  applyRootVariables(root, snapshot, appliedVariables);

  return {
    available: true,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      subscribeToWebApp();

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) unsubscribeFromWebApp();
      };
    },
    ready: () => webApp.ready(),
    expand: () => webApp.expand(),
    setBackButton(handler) {
      if (backRegistration) webApp.BackButton.offClick(backRegistration.handler);

      const registration = { handler };
      backRegistration = registration;
      webApp.BackButton.onClick(handler);
      webApp.BackButton.show();

      return () => {
        if (backRegistration !== registration) return;
        webApp.BackButton.offClick(handler);
        webApp.BackButton.hide();
        backRegistration = undefined;
      };
    },
  };
}
