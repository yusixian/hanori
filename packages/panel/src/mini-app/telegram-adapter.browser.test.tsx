import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTelegramMiniAppAdapter,
  type TelegramWebApp,
  type TelegramWebAppEvent,
} from "./telegram-adapter";

function createWebApp(): {
  webApp: TelegramWebApp;
  emit: (event: TelegramWebAppEvent) => void;
} {
  const listeners = new Map<TelegramWebAppEvent, Set<() => void>>();
  const webApp: TelegramWebApp = {
    initData: "signed-init-data",
    colorScheme: "light",
    themeParams: { bg_color: "#ffffff", text_color: "#111111" },
    viewportHeight: 640,
    viewportStableHeight: 600,
    isExpanded: false,
    safeAreaInset: { top: 10, right: 2, bottom: 20, left: 2 },
    contentSafeAreaInset: { top: 12, right: 4, bottom: 24, left: 4 },
    BackButton: {
      isVisible: false,
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn(),
      offClick: vi.fn(),
    },
    ready: vi.fn(),
    expand: vi.fn(),
    onEvent: vi.fn((event, handler) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(handler);
      listeners.set(event, eventListeners);
    }),
    offEvent: vi.fn((event, handler) => {
      listeners.get(event)?.delete(handler);
    }),
  };

  return {
    webApp,
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

function mountRoot(): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  return root;
}

beforeEach(() => {
  delete window.Telegram;
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Telegram Mini App adapter", () => {
  test("is a safe no-op when the Telegram SDK is absent", () => {
    const root = mountRoot();
    const adapter = createTelegramMiniAppAdapter(root);
    const listener = vi.fn();

    expect(adapter.available).toBe(false);
    expect(adapter.getSnapshot()).toMatchObject({
      initData: "",
      colorScheme: "light",
      viewport: { height: 0, stableHeight: 0, isExpanded: false },
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(() => {
      adapter.ready();
      adapter.expand();
      adapter.subscribe(listener)();
      adapter.setBackButton(listener)();
    }).not.toThrow();
    expect(root.getAttribute("style")).toBeNull();
  });

  test("keeps theme variables root-scoped and cleans up all event listeners", () => {
    const { webApp, emit } = createWebApp();
    window.Telegram = { WebApp: webApp };
    const root = mountRoot();
    const adapter = createTelegramMiniAppAdapter(root);
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);

    expect(webApp.onEvent).toHaveBeenCalledTimes(4);
    expect(root.style.getPropertyValue("--tg-theme-bg-color")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--tg-safe-area-inset-bottom")).toBe("20px");
    expect(document.documentElement.style.getPropertyValue("--tg-theme-bg-color")).toBe("");

    webApp.colorScheme = "dark";
    webApp.themeParams = { bg_color: "#17212b" };
    webApp.viewportHeight = 520;
    emit("themeChanged");

    expect(listener).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot()).toMatchObject({
      colorScheme: "dark",
      viewport: { height: 520 },
    });
    expect(root.style.getPropertyValue("--tg-theme-bg-color")).toBe("#17212b");
    expect(root.style.getPropertyValue("--tg-theme-text-color")).toBe("");

    unsubscribe();

    expect(webApp.offEvent).toHaveBeenCalledTimes(4);
    for (const event of [
      "themeChanged",
      "viewportChanged",
      "safeAreaChanged",
      "contentSafeAreaChanged",
    ] as const) {
      expect(webApp.offEvent).toHaveBeenCalledWith(event, expect.any(Function));
    }

    emit("viewportChanged");
    expect(listener).toHaveBeenCalledOnce();
  });

  test("initializes the native surface and cleans up BackButton ownership", () => {
    const { webApp } = createWebApp();
    window.Telegram = { WebApp: webApp };
    const adapter = createTelegramMiniAppAdapter(mountRoot());
    const handler = vi.fn();

    adapter.ready();
    adapter.expand();
    const cleanup = adapter.setBackButton(handler);

    expect(webApp.ready).toHaveBeenCalledOnce();
    expect(webApp.expand).toHaveBeenCalledOnce();
    expect(webApp.BackButton.onClick).toHaveBeenCalledWith(handler);
    expect(webApp.BackButton.show).toHaveBeenCalledOnce();

    cleanup();
    cleanup();

    expect(webApp.BackButton.offClick).toHaveBeenCalledOnce();
    expect(webApp.BackButton.offClick).toHaveBeenCalledWith(handler);
    expect(webApp.BackButton.hide).toHaveBeenCalledOnce();
  });

  test("does not inspect query or storage for a production mock", () => {
    vi.stubEnv("DEV", false);
    window.history.replaceState({}, "", "/?tgWebAppMock=1&tgWebAppColorScheme=dark");
    window.localStorage.setItem(
      "cos-tool-bot:telegram-mini-app-mock",
      JSON.stringify({ enabled: true, colorScheme: "dark" }),
    );
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    const adapter = createTelegramMiniAppAdapter(mountRoot());

    expect(adapter.available).toBe(false);
    expect(getItem).not.toHaveBeenCalled();
  });
});
