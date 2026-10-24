import { createPublicClient, http } from "viem";
import { chain, RPC_URL } from "./config.js";

export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, {
    timeout: 30_000,
    maxResponseBodySize: 2 * 1024 * 1024,
    retryCount: 3,
    retryDelay: 1000,
  }),
});
