import { createPublicClient, http } from "viem";
import { chain, getTimeoutMs, RPC_URL } from "./config.js";

export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, {
    timeout: getTimeoutMs("RPC_TIMEOUT_MS"),
    maxResponseBodySize: 2 * 1024 * 1024,
    retryCount: 3,
    retryDelay: 1000,
  }),
});

export const healthClient = createPublicClient({
  chain,
  transport: http(RPC_URL, {
    timeout: getTimeoutMs("RPC_TIMEOUT_MS"),
    maxResponseBodySize: 2 * 1024 * 1024,
    retryCount: 0,
  }),
});
