export function createSecurityHeaders(
  nonce: string,
  production: boolean,
): Record<string, string> {
  const scriptPolicy = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(production ? [] : ["'unsafe-eval'"]),
  ].join(" ");
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src ${scriptPolicy}`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Powered-By": "",
  };
}
