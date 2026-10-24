import { isAddress, getAddress, type Address } from "viem";
import { z } from "zod";
import { isIP } from "node:net";
import { checkRateLimit } from "./rate-limit";

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((value) => isAddress(value, { strict: true }));
const querySchema = z.object({ address: addressSchema }).strict();
const MAX_URL_LENGTH = 2048;

export type CheckedRequest =
  | { address: Address }
  | { response: Response };

function jsonError(message: string, status: number, retryAfter?: number): Response {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
      },
    },
  );
}

function extractIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    if (forwarded.length > 1024) return null;
    const entries = forwarded.split(",");
    if (
      entries.length > 16 ||
      entries.some((entry) => !isAddressIp(entry.trim()))
    ) {
      return null;
    }
    return entries[0]?.trim() ?? null;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp && isAddressIp(realIp) ? realIp : null;
}

function isAddressIp(value: string): boolean {
  return isIP(value) !== 0;
}

export async function checkApiRequest(
  request: Request,
): Promise<CheckedRequest> {
  if (request.url.length > MAX_URL_LENGTH) {
    return { response: jsonError("Request URL is too long.", 414) };
  }
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "address") {
    return {
      response: jsonError(
        "Provide only a valid address query parameter.",
        400,
      ),
    };
  }
  const parsed = querySchema.safeParse({ address: entries[0][1] });
  if (!parsed.success) {
    return {
      response: jsonError(
        "Provide a valid EVM address in the address query parameter.",
        400,
      ),
    };
  }

  const ip = extractIp(request);
  try {
    const limit = await checkRateLimit(ip ?? "unknown");
    if (limit.limited) {
      return {
        response: jsonError(
          "Too many requests. Please wait before trying again.",
          429,
          limit.retryAfterSeconds,
        ),
      };
    }
  } catch {
    return { response: jsonError("Request could not be processed.", 503) };
  }
  return { address: getAddress(parsed.data.address) };
}

export function rpcErrorResponse(): Response {
  return jsonError("RPC temporarily unavailable. Please retry shortly.", 503);
}

export function internalErrorResponse(): Response {
  return jsonError("Request could not be processed.", 500);
}

export function methodNotAllowedResponse(): Response {
  return jsonError("Method not allowed.", 405);
}
