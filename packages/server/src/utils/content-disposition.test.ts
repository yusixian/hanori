import { expect, it } from "vitest";
import { attachmentDisposition } from "./content-disposition.js";

it.each(['quote" and slash\\.txt', "name\r\nX-Injected: true.txt", "个人 '()* 文件.txt"])(
  "constructs a safe native response while preserving filename %j",
  (filename) => {
    const response = new Response("content", {
      headers: { "Content-Disposition": attachmentDisposition(filename) },
    });
    const header = response.headers.get("Content-Disposition")!;
    expect([...header].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127)).toBe(
      true,
    );
    expect(response.headers.get("X-Injected")).toBeNull();
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(filename);
  },
);
