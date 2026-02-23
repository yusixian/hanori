import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const keyCache = new Map<string, Buffer>();

function deriveKey(key: string): Buffer {
  let derived = keyCache.get(key);
  if (!derived) {
    derived = scryptSync(key, "cos-tool-bot-salt", 32);
    keyCache.set(key, derived);
  }
  return derived;
}

export function encrypt(plaintext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decrypt(encrypted: string, key: string): string {
  const derivedKey = deriveKey(key);
  const parts = encrypted.split(":");
  const ivB64 = parts[0] ?? "";
  const authTagB64 = parts[1] ?? "";
  const ciphertextB64 = parts[2] ?? "";
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

export function tryDecrypt(encrypted: string, key: string): string | null {
  try {
    return decrypt(encrypted, key);
  } catch {
    return null;
  }
}

export function maskToken(token: string): string {
  const colonIdx = token.indexOf(":");
  if (colonIdx === -1) {
    if (token.length <= 6) return "***";
    return token.slice(0, 3) + "***" + token.slice(-3);
  }
  const prefix = token.slice(0, colonIdx);
  const suffix = token.slice(colonIdx + 1);
  const maskedSuffix = suffix.length <= 6 ? "***" : suffix.slice(0, 3) + "***" + suffix.slice(-3);
  return `${prefix}:${maskedSuffix}`;
}
