const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SENSITIVE_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const SENSITIVE_LABEL =
  "(?:[a-z0-9]+_)*(?:encryption_key|private_key|api_key|token|secret|password|passwd|passphrase)|privateKey|encryptionKey|authorization|proxy[-_ ]?authorization|api[-_ ]?key|(?:access|refresh|auth|bearer|bot|session|csrf)[-_ ]?token|token|secret|password|passwd|passphrase|cookie|credential";
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(?<!\w)(["']?)(${SENSITIVE_LABEL})\1(\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|\[REDACTED\]|[^\s,;&}\]]+)`,
  "gi",
);

function isTokenMetric(normalized: string): boolean {
  return (
    /^(?:input|output|total|cachedinput|reasoning|prompt|completion|max|min|used|remaining|billable)tokens?$/.test(
      normalized,
    ) || /^tokens?(?:count|usage|limit|used|remaining)$/.test(normalized)
  );
}

export function isDiagnosticCredentialKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (isTokenMetric(normalized)) return false;
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "token" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("encryptionkey") ||
    normalized.endsWith("privatekey")
  );
}

export function redactDiagnosticText(input: string, secrets: readonly string[] = []): string {
  let result = input
    .replace(/(postgres(?:ql)?:\/\/[^\s/@?#:]*:)[^\s/@?#]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/api\.telegram\.org\/(?:file\/)?bot)\d+:[\w-]+/gi, "$1[REDACTED]")
    .replace(SENSITIVE_HEADER, "$1: [REDACTED]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(
      CREDENTIAL_ASSIGNMENT,
      (match, quote: string, key: string, separator: string, credential: string) => {
        if (isTokenMetric(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) return match;
        const valueQuote = /^["']/.test(credential) ? credential[0] : "";
        return `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
      },
    );
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}
