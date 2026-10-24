import { describe, expect, it } from "vitest";
import { createSecurityHeaders } from "./security-headers";

describe("security headers", () => {
  it("sets the required production policies with a CSP nonce", () => {
    const headers = createSecurityHeaders("test-nonce", true);
    const policy = headers["Content-Security-Policy"];
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).toContain("style-src 'self' 'nonce-test-nonce'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    expect(headers["X-Powered-By"]).toBe("");
  });
});
