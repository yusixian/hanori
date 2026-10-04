import { Lexer, type Token } from "marked";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Streaming rich media cannot wait for a classifier on every draft. Cover all inline photos. */
export function coverRichHtmlImages(html: string): string {
  return html.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const attrs = [...tag.matchAll(/\s+([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)];
    if (
      attrs.some(
        (attr) => attr[1]!.toLowerCase() === "src" && /^['"]?tg:\/\/emoji\?/i.test(attr[2] ?? ""),
      )
    )
      return tag;
    // Attribute values may contain "tg-spoiler" or "src". Only actual attributes count.
    for (const attr of attrs.reverse()) {
      if (attr[1]!.toLowerCase() === "tg-spoiler")
        tag = tag.slice(0, attr.index) + tag.slice(attr.index! + attr[0].length);
    }
    return tag.replace(/\s*\/?\s*>$/, " tg-spoiler/>");
  });
}

export function coverRichMarkdownImages(markdown: string): string {
  const tokens = Lexer.lex(markdown);
  function collect(token: Token, edits: Map<string, string>) {
    if (token.type === "code" || token.type === "codespan") return;
    if (token.type === "image")
      edits.set(token.raw, `<img src="${escapeAttribute(token.href)}" tg-spoiler/>`);
    if (token.type === "html") {
      const covered = coverRichHtmlImages(token.raw);
      if (covered !== token.raw) edits.set(token.raw, covered);
    }
    if ("tokens" in token && token.tokens) for (const child of token.tokens) collect(child, edits);
    if (token.type === "list") for (const item of token.items) collect(item, edits);
    if (token.type === "table")
      for (const cell of [...token.header, ...token.rows.flat()])
        for (const child of cell.tokens) collect(child, edits);
  }
  return tokens
    .map((token) => {
      const edits = new Map<string, string>();
      collect(token, edits);
      let raw = token.raw;
      for (const [image, covered] of edits) {
        // Multiline quoted markup may not preserve raw token text. Refuse the rich send
        // instead of accidentally returning an image without protection.
        if (!raw.includes(image)) throw new Error("Rich image markup cannot be safely covered");
        raw = raw.replaceAll(image, covered);
      }
      return raw;
    })
    .join("");
}
