import {
  checkApiRequest,
  internalErrorResponse,
  methodNotAllowedResponse,
  rpcErrorResponse,
} from "@/lib/api-response";
import { getTransfers, logApiRequest, RpcFailure, type CacheStatus } from "@/lib/server";
import { withRequestBudget } from "@/lib/request-budget";

export const runtime = "nodejs";
export const maxDuration = 25;

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let cache: CacheStatus = "miss";
  try {
    if (request.method !== "GET") return methodNotAllowedResponse();
    const checked = await checkApiRequest(request);
    if ("response" in checked) return checked.response;
    try {
      const result = await withRequestBudget(20_000, () =>
        getTransfers(checked.address),
      );
      cache = result.cache;
      return Response.json(result.value, {
        headers: { "cache-control": "private, max-age=15" },
      });
    } catch (error) {
      if (error instanceof RpcFailure) return rpcErrorResponse();
      return internalErrorResponse();
    }
  } finally {
    logApiRequest("/api/transfers", request, startedAt, cache);
  }
}
