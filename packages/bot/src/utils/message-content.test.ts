import type { Message, MessageEntity } from "grammy/types";
import { describe, expect, it } from "vitest";
import { describeAdditionalMessageContent, telegramContentKind } from "./message-content.js";

describe("Telegram content descriptions", () => {
  it("retains nested rich text, links, captions and honest media placeholders without file identifiers", () => {
    const message = {
      rich_message: {
        blocks: [
          { type: "heading", size: 1, text: { type: "bold", text: "Heading" } },
          {
            type: "details",
            summary: "Details",
            blocks: [
              {
                type: "list",
                items: [
                  {
                    label: "1.",
                    blocks: [
                      {
                        type: "paragraph",
                        text: [
                          "See ",
                          { type: "url", text: "reference", url: "https://example.com/reference" },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                type: "table",
                caption: "Table",
                cells: [[{ text: "Cell", align: "left", valign: "top" }]],
              },
              {
                type: "photo",
                photo: [{ file_id: "private-file-id" }],
                caption: { text: "Photo caption", credit: "Creator" },
              },
              {
                type: "blockquote",
                blocks: [{ type: "pre", text: "const n = 1" }],
                credit: "Author",
              },
            ],
          },
        ],
      },
    } as Message;
    const content = describeAdditionalMessageContent(message);
    for (const text of [
      "Heading",
      "Details",
      "1. See reference",
      "https://example.com/reference",
      "Table",
      "Cell",
      "Photo caption",
      "Creator",
      "const n = 1",
      "Author",
      "未解析媒体内容",
    ])
      expect(content).toContain(text);
    expect(content).not.toContain("private-file-id");
    expect(describeAdditionalMessageContent(message, true)).toContain("未解析媒体内容");
    expect(describeAdditionalMessageContent(message, true)).not.toContain("Heading");
    expect(describeAdditionalMessageContent(message, true)).not.toContain(
      "https://example.com/reference",
    );
  });

  it("preserves URLs hidden in poll and checklist entities, including option media limitations", () => {
    const entities: MessageEntity[] = [
      { type: "text_link", offset: 0, length: 4, url: "https://example.com/hidden" },
    ];
    const poll = describeAdditionalMessageContent({
      message_id: 1,
      date: 0,
      chat: { id: -1, type: "group", title: "Test" },
      poll: {
        question: "Vote",
        options: [
          {
            text: "Link",
            text_entities: entities,
            voter_count: 0,
            media: {
              photo: [{ file_id: "fixture", file_unique_id: "fixture", width: 10, height: 10 }],
            },
          },
        ],
        description: "Link",
        description_entities: entities,
        total_voter_count: 0,
        is_closed: false,
      },
    } as Message);
    expect(poll).toContain("https://example.com/hidden");
    expect(poll).toContain("投票附件：未解析媒体内容");
    const checklist = describeAdditionalMessageContent({
      checklist: {
        title: "List",
        tasks: [{ id: 1, text: "Link", text_entities: entities, completion_date: 1 }],
      },
    } as Message);
    expect(checklist).toContain("[x] Link\nhttps://example.com/hidden");
  });

  it("preserves poll option links and location metadata", () => {
    const content = describeAdditionalMessageContent({
      poll: {
        question: "Where?",
        total_voter_count: 0,
        is_closed: false,
        options: [
          { text: "Site", voter_count: 0, media: { link: { url: "https://example.com/site" } } },
        ],
        media: {
          venue: { title: "Park", address: "Road", location: { latitude: 1, longitude: 2 } },
        },
        explanation_media: { location: { latitude: 3, longitude: 4 } },
      },
    } as Message);
    expect(content).toContain("https://example.com/site");
    expect(content).toContain("Park；Road；1, 2");
    expect(content).toContain("3, 4");
    expect(content).toContain("0 也可能表示未知");
  });

  it("classifies compatibility fields by their actual content and ignores arbitrary service fields", () => {
    expect(telegramContentKind({ animation: {}, document: {} } as Message)).toBe("animation");
    expect(telegramContentKind({ venue: {}, location: {} } as Message)).toBe("venue");
    expect(telegramContentKind({ live_photo: {}, photo: [] } as unknown as Message)).toBe(
      "live_photo",
    );
    expect(telegramContentKind({ checklist_tasks_added: {} } as Message)).toBe("other");
  });
});
