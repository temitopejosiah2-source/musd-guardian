import { isHex, TransactionReceiptNotFoundError } from "viem";
import {
  checkApiRateLimit,
  methodNotAllowedResponse,
  rpcErrorResponse,
} from "@/lib/api-response";
import { logApiRequest, publicClient } from "@/lib/server";
import { withRequestBudget } from "@/lib/request-budget";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (request.method !== "GET") return methodNotAllowedResponse();
    const url = new URL(request.url);
    const hashes = url.searchParams.getAll("hash");
    const hash = hashes[0];
    if (request.url.length > 2048 || [...url.searchParams.keys()].length !== 1 ||
      hashes.length !== 1 || !hash || !isHex(hash, { strict: true }) || hash.length !== 66) {
      return Response.json({ error: "Provide one valid transaction hash." }, {
        status: 400,
        headers: { "cache-control": "no-store" },
      });
    }
    const rateLimitResponse = await checkApiRateLimit(request);
    if (rateLimitResponse) return rateLimitResponse;
    try {
      const receipt = await withRequestBudget(10_000, () =>
        publicClient.getTransactionReceipt({ hash }),
      );
      return Response.json({
        status: receipt.status === "success" ? "confirmed" : "failed",
        blockNumber: receipt.blockNumber.toString(),
      }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        return Response.json({ status: "pending" }, { headers: { "cache-control": "no-store" } });
      }
      return rpcErrorResponse();
    }
  } finally {
    logApiRequest("/api/protect/receipt", request, startedAt);
  }
}
