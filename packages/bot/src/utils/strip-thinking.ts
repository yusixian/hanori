/**
 * Strip reasoning/thinking content leaked by AI models (DeepSeek R1, etc.)
 * into the text output when using OpenAI-compatible proxies.
 *
 * This is a preventive filter — it only matches specific thinking tag patterns
 * and will not affect normal content.
 */

/** Callback for logging when thinking content is stripped */
export type ThinkingFilterLogger = (info: { pattern: string; strippedLength: number }) => void;

// ─── Regex patterns for known thinking tag formats ───

const THINKING_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /<think>[\s\S]*?<\/think>/gi, label: "<think>" },
  { re: /<thought>[\s\S]*?<\/thought>/gi, label: "<thought>" },
  { re: /<reasoning>[\s\S]*?<\/reasoning>/gi, label: "<reasoning>" },
  // Garbled proxy format: non-ASCII prefix + "thought" ... "(End thought)"
  {
    re: /[\u0080-\uFFFF]+thought[\s\S]*?\(End thought\)/gi,
    label: "garbled-thought",
  },
];

/**
 * Synchronously strip all thinking/reasoning content from a complete text.
 * Used for segment (non-stream) mode.
 */
export function stripThinkingContent(text: string, onStripped?: ThinkingFilterLogger): string {
  let result = text;
  for (const { re, label } of THINKING_PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    const before = result;
    result = result.replace(re, "");
    if (result.length < before.length) {
      onStripped?.({
        pattern: label,
        strippedLength: before.length - result.length,
      });
    }
  }
  return result.trim();
}

// ─── Stream filter (stateful, handles cross-chunk tags) ───

/** Known opening tags and their corresponding closing tags */
const TAG_PAIRS: Array<{
  open: RegExp;
  close: RegExp;
  label: string;
}> = [
  { open: /<think>/i, close: /<\/think>/i, label: "<think>" },
  { open: /<thought>/i, close: /<\/thought>/i, label: "<thought>" },
  { open: /<reasoning>/i, close: /<\/reasoning>/i, label: "<reasoning>" },
  {
    open: /[\u0080-\uFFFF]+thought/i,
    close: /\(End thought\)/i,
    label: "garbled-thought",
  },
];

/**
 * Lookahead buffer size.
 * Must be large enough to hold any opening/closing tag we want to detect
 * when it arrives split across two chunks.
 */
const LOOKAHEAD = 30;

export interface ThinkingStreamFilter {
  /** Feed a chunk; returns the portion that should be forwarded. */
  push(chunk: string): string;
  /** Flush remaining buffer at end-of-stream. */
  flush(): string;
}

/**
 * Create a stateful stream filter that strips thinking tags from a chunk stream.
 * Maintains a small lookahead buffer to handle tags split across chunks.
 */
export function createThinkingStreamFilter(
  onStripped?: ThinkingFilterLogger,
): ThinkingStreamFilter {
  let state: "passthrough" | "inside_tag" = "passthrough";
  let buffer = "";
  let activeLabel = "";
  let activeCloseRe: RegExp | null = null;
  let strippedTotal = 0;

  return {
    push(chunk: string): string {
      buffer += chunk;
      let output = "";

      while (buffer.length > 0) {
        if (state === "passthrough") {
          // Check if any opening tag starts in the buffer
          let earliestIdx = -1;
          let matchedPair: (typeof TAG_PAIRS)[number] | null = null;
          let matchLen = 0;

          for (const pair of TAG_PAIRS) {
            const m = pair.open.exec(buffer);
            if (m && (earliestIdx === -1 || m.index < earliestIdx)) {
              earliestIdx = m.index;
              matchedPair = pair;
              matchLen = m[0].length;
            }
          }

          if (matchedPair && earliestIdx !== -1) {
            // Emit everything before the tag
            output += buffer.slice(0, earliestIdx);
            // Enter inside_tag state
            state = "inside_tag";
            activeCloseRe = matchedPair.close;
            activeLabel = matchedPair.label;
            strippedTotal = matchLen;
            buffer = buffer.slice(earliestIdx + matchLen);
          } else if (buffer.length > LOOKAHEAD) {
            // No tag found — emit everything except the lookahead tail
            const safe = buffer.length - LOOKAHEAD;
            output += buffer.slice(0, safe);
            buffer = buffer.slice(safe);
            break;
          } else {
            // Buffer is small, wait for more data
            break;
          }
        } else {
          // state === "inside_tag" — looking for closing tag
          const m = activeCloseRe!.exec(buffer);
          if (m) {
            strippedTotal += m.index + m[0].length;
            onStripped?.({
              pattern: activeLabel,
              strippedLength: strippedTotal,
            });
            buffer = buffer.slice(m.index + m[0].length);
            state = "passthrough";
            activeCloseRe = null;
            activeLabel = "";
          } else if (buffer.length > LOOKAHEAD) {
            // Discard content inside tag, keep tail for partial close tag
            strippedTotal += buffer.length - LOOKAHEAD;
            buffer = buffer.slice(buffer.length - LOOKAHEAD);
            break;
          } else {
            break;
          }
        }
      }

      return output;
    },

    flush(): string {
      if (state === "inside_tag") {
        // Tag never closed — entire remaining buffer is thinking content
        onStripped?.({
          pattern: activeLabel,
          strippedLength: strippedTotal + buffer.length,
        });
        buffer = "";
        state = "passthrough";
        return "";
      }
      // Emit remaining buffer
      const out = buffer;
      buffer = "";
      return out;
    },
  };
}

/**
 * Convenience wrapper: filters an async text stream, stripping thinking content.
 */
export async function* filterThinkingStream(
  textStream: AsyncIterable<string>,
  onStripped?: ThinkingFilterLogger,
): AsyncGenerator<string> {
  const filter = createThinkingStreamFilter(onStripped);
  for await (const chunk of textStream) {
    const out = filter.push(chunk);
    if (out) yield out;
  }
  const flushed = filter.flush();
  if (flushed) yield flushed;
}
