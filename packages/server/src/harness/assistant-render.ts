import { HARNESS_CALLBACK_PREFIX, type HarnessKeyboard } from "@cos-tool-bot/bot";
import { escapeHtml } from "@cos-tool-bot/bot/utils/format";
import type { HarnessTopicSuggestion } from "@cos-tool-bot/database";

/** `hx:t:<index>`: the suggestion lives on the stored assistant message the button belongs to. */
const CALLBACK_PREFIX = `${HARNESS_CALLBACK_PREFIX}t:`;
const BODY_LIMIT = 3300;
export const SUGGESTION_ARGS_LIMIT = 1000;

export function suggestionCallback(index: number): string {
  return `${CALLBACK_PREFIX}${index}`;
}

export function isAssistantCallback(data: string): boolean {
  return data.startsWith(CALLBACK_PREFIX);
}

export function parseAssistantCallback(data: string): number | null {
  const match = /^(\d)$/.exec(data.slice(CALLBACK_PREFIX.length));
  return isAssistantCallback(data) && match ? Number(match[1]) : null;
}

/** Largest prefix whose escaped form fits, without splitting a surrogate pair. */
function fittingPrefix(text: string, limit: number): number {
  let size = Math.min(text.length, limit);
  let escaped = escapeHtml(text.slice(0, size)).length;
  while (escaped > limit && size > 1) {
    size = Math.max(1, Math.floor((size * limit) / escaped));
    escaped = escapeHtml(text.slice(0, size)).length;
  }
  const code = text.charCodeAt(size - 1);
  return size > 1 && code >= 0xd800 && code <= 0xdbff ? size - 1 : size;
}

/** Splits on line breaks so each piece stays within `limit` once HTML-escaped. */
export function splitForTelegram(text: string, limit = BODY_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (let line of text.split("\n")) {
    const joined = current ? `${current}\n${line}` : line;
    if (escapeHtml(joined).length <= limit) {
      current = joined;
      continue;
    }
    flush();
    while (escapeHtml(line).length > limit) {
      const size = fittingPrefix(line, limit);
      chunks.push(line.slice(0, size));
      line = line.slice(size);
    }
    current = line;
  }
  flush();
  return chunks;
}

function linkIssues(html: string, repo: string | undefined): string {
  if (!repo) return html;
  const base = `https://github.com/${escapeHtml(repo)}/issues/`;
  return html.replace(/(^|[^\w&/#])#(\d{1,7})\b/g, `$1<a href="${base}$2">#$2</a>`);
}

function renderSuggestion(suggestion: HarnessTopicSuggestion, index: number, used: boolean) {
  const target = suggestion.project ? `（${escapeHtml(suggestion.project)}）` : "";
  const head = `<b>建议 ${index + 1}</b>：<code>/${escapeHtml(suggestion.command)}</code>${target}${used ? " · ✅ 已执行" : ""}`;
  if (!suggestion.args) return head;
  const args =
    suggestion.args.length > SUGGESTION_ARGS_LIMIT
      ? `${suggestion.args.slice(0, SUGGESTION_ARGS_LIMIT)}…`
      : suggestion.args;
  return `${head}\n<blockquote expandable>${escapeHtml(args)}</blockquote>`;
}

export interface RenderedReply {
  chunks: string[];
  /** Belongs to the last chunk. */
  keyboard: HarnessKeyboard;
}

/** Deterministic, so a button tap can re-render the message it edits from the stored row. */
export function renderAssistantReply(input: {
  text: string;
  suggestions: readonly HarnessTopicSuggestion[];
  usedMask: number;
  repo?: string;
}): RenderedReply {
  const chunks = splitForTelegram(input.text).map((chunk) =>
    linkIssues(escapeHtml(chunk), input.repo),
  );
  const isUsed = (index: number) => (input.usedMask & (1 << index)) !== 0;
  if (input.suggestions.length > 0) {
    const block = input.suggestions
      .map((suggestion, index) => renderSuggestion(suggestion, index, isUsed(index)))
      .join("\n");
    // Sized as if every suggestion were used, so marking one never moves the block.
    const widest = input.suggestions
      .map((suggestion, index) => renderSuggestion(suggestion, index, true))
      .join("\n");
    const last = chunks.at(-1);
    if (last !== undefined && last.length + widest.length + 2 <= BODY_LIMIT + 400) {
      chunks[chunks.length - 1] = `${last}\n\n${block}`;
    } else {
      chunks.push(block);
    }
  }
  const keyboard = input.suggestions.flatMap((suggestion, index) =>
    isUsed(index)
      ? []
      : [
          [
            {
              text: `▶️ 执行建议 ${index + 1}：/${suggestion.command}`,
              callbackData: suggestionCallback(index),
            },
          ],
        ],
  );
  return { chunks: chunks.length > 0 ? chunks : ["（没有内容）"], keyboard };
}
