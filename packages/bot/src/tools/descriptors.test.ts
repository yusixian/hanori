import { describe, expect, it } from "vitest";
import {
  getToolCacheKey,
  getToolCallLimit,
  getToolStatusLabel,
  READ_ONLY_TOOL_NAMES,
  TOOL_DESCRIPTORS,
  VISIBLE_EFFECT_TOOL_NAMES,
} from "./descriptors.js";

const EXPECTED_VISIBLE_EFFECT_TOOL_NAMES = new Set([
  "react_to_message",
  "send_sticker",
  "send_photo",
  "send_voice",
  "send_document",
  "send_media_group",
  "send_poll",
  "send_choice",
  "reply_to_specific",
  "close_poll",
  "set_timer",
  "cancel_timer",
  "send_dice",
  "edit_own_message",
  "delete_own_message",
  "pin_message",
  "set_mood",
  "send_artwork",
  "create_image",
  "cancel_image_generation",
]);

const EXPECTED_READ_ONLY_TOOL_NAMES = new Set([
  "search",
  "read_reference",
  "get_runtime_status",
  "get_effective_config",
  "get_request_trace",
  "query_sanitized_logs",
  "get_recent_errors",
  "get_chat_info",
  "get_current_time",
  "web_search",
  "fetch_webpage",
  "read_file",
  "check_rss",
  "list_rss_feeds",
  "get_profile",
  "get_profile_avatar",
  "search_profiles",
  "search_history",
  "recall_memories",
  "fetch_artwork_info",
  "list_image_presets",
  "get_image_generation",
  "github_repository",
  "github_read_file",
  "github_list_tree",
  "github_list_issues",
  "github_inspect_workspace",
  "delegate_task",
  "get_character_bindings",
  "search_prompt_assets",
]);

describe("tool descriptors", () => {
  it("derives the former literal effect sets unchanged", () => {
    expect(VISIBLE_EFFECT_TOOL_NAMES).toEqual(EXPECTED_VISIBLE_EFFECT_TOOL_NAMES);
    expect(READ_ONLY_TOOL_NAMES).toEqual(EXPECTED_READ_ONLY_TOOL_NAMES);
  });

  it("never classifies a tool as both read-only and visible", () => {
    for (const descriptor of TOOL_DESCRIPTORS) {
      expect(
        READ_ONLY_TOOL_NAMES.has(descriptor.name) && VISIBLE_EFFECT_TOOL_NAMES.has(descriptor.name),
      ).toBe(false);
    }
  });

  it("keeps the per-tool call budgets", () => {
    expect(getToolCallLimit("search")).toBe(64);
    expect(getToolCallLimit("read_reference")).toBe(128);
    expect(getToolCacheKey("search", { scope: "web", query: "A" })).toBeUndefined();
    expect(
      getToolCacheKey("read_reference", { reference: "ref", offset: 0, limit: 1 }),
    ).toBeUndefined();
    expect(getToolCallLimit("fetch_webpage")).toBe(128);
    expect(getToolCallLimit("web_search")).toBe(64);
    expect(getToolCallLimit("fetch_artwork_info")).toBe(64);
    expect(getToolCallLimit("delegate_task")).toBe(64);
    expect(getToolCallLimit("search_danbooru_character_tags")).toBe(64);
    expect(getToolCallLimit("send_photo")).toBeUndefined();
  });

  it("builds cache keys only for the cacheable tools", () => {
    expect(getToolCacheKey("fetch_webpage", { url: "https://x.com/a/status/123?s=1" })).toBe(
      "fetch_webpage:tweet:123",
    );
    expect(
      getToolCacheKey("fetch_artwork_info", { url: "https://www.pixiv.net/artworks/456" }),
    ).toBe("fetch_artwork_info:pixiv:456");
    expect(getToolCacheKey("web_search", { query: "  Hello World " })).toBe(
      "web_search:hello world",
    );
    expect(getToolCacheKey("send_photo", { url: "https://example.com" })).toBeUndefined();
  });

  it("keeps the status labels", () => {
    expect(getToolStatusLabel("web_search")).toBe("🌐 搜索中...");
    expect(getToolStatusLabel("react_to_message")).toBeUndefined();
  });
});
