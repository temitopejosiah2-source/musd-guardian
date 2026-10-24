import { NextResponse, type NextRequest } from "next/server";
import { createSecurityHeaders } from "./src/lib/security-headers";

export function middleware(request: NextRequest): NextResponse {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const securityHeaders = createSecurityHeaders(
    nonce,
    process.env.NODE_ENV === "production",
  );
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", securityHeaders["Content-Security-Policy"]!);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (value) response.headers.set(name, value);
    else response.headers.delete(name);
  }

  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    request.method !== "GET"
  ) {
    return NextResponse.json(
      { error: "Method not allowed." },
      {
        status: 405,
        headers: {
          allow: "GET",
          "cache-control": "no-store",
          ...Object.fromEntries(
            Object.entries(securityHeaders).filter(([, value]) => value),
          ),
        },
      },
    );
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
