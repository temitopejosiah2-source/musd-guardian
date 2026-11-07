import { getAddress, isAddress } from "viem";
import { z } from "zod";
import {
  checkApiRateLimit,
  methodNotAllowedResponse,
  rpcErrorResponse,
} from "@/lib/api-response";
import {
  buildProtectPlan,
  ProtectPlanError,
} from "@/lib/protect";
import { logApiRequest } from "@/lib/server";
import { withRequestBudget } from "@/lib/request-budget";

export const runtime = "nodejs";
export const maxDuration = 30;

const requestSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine((value) => isAddress(value, { strict: true })),
  action: z.enum(["add_collateral", "repay"]),
  amount: z.string().min(1).max(100),
}).strict();
const MAX_BODY_BYTES = 4096;

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (request.method !== "POST") return methodNotAllowedResponse();
    if (new URL(request.url).search || request.url.length > 2048) {
      return Response.json({ error: "Request URL is invalid." }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return Response.json({ error: "Request body is too large." }, { status: 413, headers: { "cache-control": "no-store" } });
    }
    const rateLimitResponse = await checkApiRateLimit(request);
    if (rateLimitResponse) return rateLimitResponse;

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
      return Response.json({ error: "Request body is too large." }, { status: 413, headers: { "cache-control": "no-store" } });
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      return Response.json({ error: "Provide a valid JSON request body." }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Provide a valid address, action, and decimal amount." }, { status: 400, headers: { "cache-control": "no-store" } });
    }

    try {
      const plan = await withRequestBudget(25_000, () =>
        buildProtectPlan(getAddress(parsed.data.address), parsed.data.action, parsed.data.amount),
      );
      return Response.json(plan, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof ProtectPlanError) {
        return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
      }
      return rpcErrorResponse();
    }
  } finally {
    logApiRequest("/api/protect/plan", request, startedAt);
  }
}
