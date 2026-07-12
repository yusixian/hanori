/**
 * Strip role/meta prefixes the LLM occasionally leaks into its own output,
 * mimicking the history format injected into the prompt.
 *
 * Observed leakage patterns:
 *   [From: cos (@example_user)] hello
 *   [From: 星野爱 (@hoshino_ai)] ...
 *
 * This is a defensive post-processor — paired with prompt rules, it catches
 * any residual leakage so users never see the template escape into replies.
 */

export type MetaPrefixLogger = (info: { pattern: string; strippedLength: number }) => void;

// ─── Segment mode (sync, full-text) ───

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // [From: name] or [From: name (@username)]
  { re: /\[From:\s*[^\]\n]*\]\s*/g, label: "[From:...]" },
];

/** Strip all known meta prefixes from a complete text. */
export function stripMetaPrefix(text: string, onStripped?: MetaPrefixLogger): string {
  let result = text;
  for (const { re, label } of PATTERNS) {
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

// ─── Stream mode (stateful, handles cross-chunk tags) ───

const OPEN_RE = /\[From:/i;
const CLOSE_RE = /\]/;
/** Lookahead buffer for detecting "[From:" split across chunks (length of the opening tag). */
const OPEN_LOOKAHEAD = 8;
/** Max distance from "[From:" to its closing "]". Beyond this we treat as false positive. */
const MAX_TAG_LENGTH = 200;

export interface MetaPrefixStreamFilter {
  /** Feed a chunk; returns the portion safe to forward. */
  push(chunk: string): string;
  /** Flush remaining buffer at end-of-stream. */
  flush(): string;
}

/**
 * Create a stateful stream filter that strips `[From: ...]` leaks.
 * Handles tags split across chunks via a small lookahead buffer.
 */
export function createMetaPrefixStreamFilter(
  onStripped?: MetaPrefixLogger,
): MetaPrefixStreamFilter {
  let state: "passthrough" | "inside" = "passthrough";
  let buffer = "";
  let strippedTotal = 0;
  let openText = "[From:";
  // Whitespace after a stripped tag may land in a later chunk; carry the intent across pushes.
  let swallowWs = false;

  return {
    push(chunk: string): string {
      buffer += chunk;
      let output = "";

      while (buffer.length > 0) {
        if (state === "passthrough") {
          if (swallowWs) {
            const ws = /^\s+/.exec(buffer);
            if (ws) buffer = buffer.slice(ws[0].length);
            if (buffer.length === 0) break;
            swallowWs = false;
          }
          const m = OPEN_RE.exec(buffer);
          if (m) {
            output += buffer.slice(0, m.index);
            state = "inside";
            strippedTotal = m[0].length;
            openText = m[0];
            buffer = buffer.slice(m.index + m[0].length);
          } else if (buffer.length > OPEN_LOOKAHEAD) {
            const safe = buffer.length - OPEN_LOOKAHEAD;
            output += buffer.slice(0, safe);
            buffer = buffer.slice(safe);
            break;
          } else {
            break;
          }
        } else {
          const m = CLOSE_RE.exec(buffer);
          if (m) {
            strippedTotal += m.index + m[0].length;
            // Also swallow a single run of trailing whitespace after ].
            let rest = buffer.slice(m.index + m[0].length);
            const ws = /^\s+/.exec(rest);
            if (ws) {
              strippedTotal += ws[0].length;
              rest = rest.slice(ws[0].length);
            } else if (rest.length === 0) {
              swallowWs = true;
            }
            onStripped?.({ pattern: "[From:...]", strippedLength: strippedTotal });
            buffer = rest;
            state = "passthrough";
            strippedTotal = 0;
          } else if (buffer.length > MAX_TAG_LENGTH) {
            // No close within reasonable distance — treat as false positive, emit original.
            output += openText + buffer;
            buffer = "";
            state = "passthrough";
            strippedTotal = 0;
          } else {
            break;
          }
        }
      }

      return output;
    },

    flush(): string {
      if (state === "inside") {
        // Unclosed leak at EOS — discard.
        onStripped?.({
          pattern: "[From:...] (unclosed)",
          strippedLength: strippedTotal + buffer.length,
        });
        buffer = "";
        state = "passthrough";
        strippedTotal = 0;
        return "";
      }
      const out = buffer;
      buffer = "";
      return out;
    },
  };
}

/** Async wrapper: filter a text stream, stripping meta prefixes. */
export async function* filterMetaPrefixStream(
  textStream: AsyncIterable<string>,
  onStripped?: MetaPrefixLogger,
): AsyncGenerator<string> {
  const filter = createMetaPrefixStreamFilter(onStripped);
  for await (const chunk of textStream) {
    const out = filter.push(chunk);
    if (out) yield out;
  }
  const flushed = filter.flush();
  if (flushed) yield flushed;
}
