export const APP_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

export const MINI_APP_SECURITY_HEADERS = {
  ...APP_SECURITY_HEADERS,
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; object-src 'none'; form-action 'self'",
} as const;

export function securityHeaders(pathname: string) {
  return pathname === "/mini-app" || pathname.startsWith("/mini-app/")
    ? MINI_APP_SECURITY_HEADERS
    : APP_SECURITY_HEADERS;
}

export function staticCacheControl(pathname: string): string {
  return pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache, no-store, must-revalidate";
}
