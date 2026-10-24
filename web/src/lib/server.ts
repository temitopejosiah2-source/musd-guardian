import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Log,
} from "viem";
import { decodeEventLog, formatUnits, getAddress } from "viem";
import type { HealthLevel } from "./format";
import { getRequestSignal } from "./request-budget";

export const EXPLORER_URL = "https://explorer.test.mezo.org";
export const MUSD_ADDRESS =
  "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" as const;
export const TROVE_MANAGER_ADDRESS =
  "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0" as const;
export const PRICE_FEED_ADDRESS =
  "0x86bCF0841622a5dAC14A313a15f96A95421b9366" as const;
export const LOOKBACK_BLOCKS = 6_000n;
export const LOG_CHUNK_SIZE = 2_000n;
const MAX_PARALLEL_TRANSFER_CHUNKS = 3;
const MAX_LOOKBACK_BLOCKS = 120_000n;
const TRANSFER_DEADLINE_MS = 19_000;
const NATIVE_DECIMALS = 18;
const FRESH_CACHE_MS = 15_000;
const STALE_CACHE_MS = 5 * 60_000;
const HEALTH_ATTEMPTS = 4;

const chain = defineChain({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: NATIVE_DECIMALS },
  rpcUrls: {
    default: { http: ["https://rpc.test.mezo.org"] },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: EXPLORER_URL },
  },
});

function getRpcUrl(): string {
  const value = process.env.RPC_URL?.trim() || "https://rpc.test.mezo.org";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RPC_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("RPC_URL must use HTTPS");
  }
  return value;
}

const MAX_RPC_RESPONSE_BYTES = 1_000_000;
const RPC_TIMEOUT_MS = 15_000;

const boundedFetch: typeof fetch = async (input, init) => {
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const requestSignal = getRequestSignal();
  const abort = (): void => controller.abort(upstreamSignal?.reason);
  const abortForBudget = (): void => controller.abort(requestSignal?.reason);
  if (upstreamSignal?.aborted) abort();
  else upstreamSignal?.addEventListener("abort", abort, { once: true });
  if (requestSignal?.aborted) abortForBudget();
  else requestSignal?.addEventListener("abort", abortForBudget, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("RPC request timed out", "TimeoutError")),
    RPC_TIMEOUT_MS,
  );

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RPC_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("RPC response exceeds the configured size limit");
    }
    if (!response.body) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_RPC_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("RPC response exceeds the configured size limit");
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abort);
    requestSignal?.removeEventListener("abort", abortForBudget);
  }
};

const publicClient = createPublicClient({
  chain,
  transport: http(getRpcUrl(), {
    timeout: RPC_TIMEOUT_MS,
    retryCount: 0,
    fetchFn: boundedFetch,
  }),
});

const troveManagerAbi = parseAbi([
  "function getTroveColl(address _borrower) view returns (uint256)",
  "function getTroveDebt(address _borrower) view returns (uint256)",
  "function getTroveStatus(address _borrower) view returns (uint8)",
  "function DECIMAL_PRECISION() view returns (uint256)",
]);
const priceFeedAbi = parseAbi(["function fetchPrice() view returns (uint256)"]);
const musdAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface HealthResponse {
  address: Address;
  troveActive: boolean;
  collateralBtc: number;
  debtMusd: number;
  btcPriceUsd: number;
  collateralValueUsd: number;
  ltvPercent: number;
  liquidationLtvPercent: 90;
  distanceToLiquidationPercent: number;
  level: HealthLevel;
  warnLtv: number;
  dangerLtv: number;
  updatedAt: string;
  stale?: boolean;
}

export interface TransferItem {
  direction: "IN" | "OUT";
  amount: string;
  counterparty: Address;
  block: string;
  txHash: `0x${string}`;
  logIndex: number;
  explorerLink: string;
}

export interface TransfersResponse {
  address: Address;
  transfers: TransferItem[];
  partial: boolean;
  updatedAt: string;
  stale?: boolean;
}

export class RpcFailure extends Error {}

export type CacheStatus = "hit" | "stale" | "miss";

export interface ApiResult<T> {
  value: T;
  cache: CacheStatus;
}

const healthCache = new Map<string, { expiresAt: number; value: HealthResponse }>();
const lastGoodHealth = new Map<string, { expiresAt: number; value: HealthResponse }>();
const transfersCache = new Map<string, { expiresAt: number; value: TransfersResponse }>();
const lastGoodTransfers = new Map<string, { expiresAt: number; value: TransfersResponse }>();
const MAX_CACHE_ENTRIES = 1000;

function setCache<T>(
  cache: Map<string, { expiresAt: number; value: T }>,
  key: string,
  value: T,
  lifetimeMs: number,
): void {
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(entryKey);
  }
  while (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, { expiresAt: now + lifetimeMs, value });
}

function getThresholds(): { warn: number; danger: number } {
  const parseThreshold = (
    key: "WARN_LTV" | "DANGER_LTV",
    fallback: number,
  ): number => {
    const raw =
      key === "WARN_LTV"
        ? process.env.WARN_LTV?.trim()
        : process.env.DANGER_LTV?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw new Error("Invalid health threshold configuration");
    }
    return value;
  };
  const warn = parseThreshold("WARN_LTV", 70);
  const danger = parseThreshold("DANGER_LTV", 80);
  if (danger <= warn) throw new Error("Invalid health threshold configuration");
  return { warn, danger };
}

function decimalPlaces(precision: bigint): number {
  if (precision <= 0n) throw new Error("Invalid precision");
  let value = precision;
  let places = 0;
  while (value % 10n === 0n) {
    value /= 10n;
    places += 1;
  }
  if (value !== 1n) throw new Error("Invalid precision");
  return places;
}

function numeric(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error("Numeric value is outside supported range");
  return result;
}

function getMusdDecimals(): Promise<number> {
  return publicClient
    .readContract({
      address: MUSD_ADDRESS,
      abi: musdAbi,
      functionName: "decimals",
    })
    .then(Number);
}

function levelFor(ltv: number, active: boolean): HealthLevel {
  if (!active) return "NO_LOAN";
  const { warn, danger } = getThresholds();
  if (ltv >= danger) return "DANGER";
  if (ltv >= warn) return "WARNING";
  return "SAFE";
}

async function fetchHealth(address: Address): Promise<HealthResponse> {
  try {
    const [collateralRaw, debtRaw, statusRaw, priceRaw, precision, musdDecimals] =
      await Promise.all([
        publicClient.readContract({
          address: TROVE_MANAGER_ADDRESS,
          abi: troveManagerAbi,
          functionName: "getTroveColl",
          args: [address],
        }),
        publicClient.readContract({
          address: TROVE_MANAGER_ADDRESS,
          abi: troveManagerAbi,
          functionName: "getTroveDebt",
          args: [address],
        }),
        publicClient.readContract({
          address: TROVE_MANAGER_ADDRESS,
          abi: troveManagerAbi,
          functionName: "getTroveStatus",
          args: [address],
        }),
        publicClient.readContract({
          address: PRICE_FEED_ADDRESS,
          abi: priceFeedAbi,
          functionName: "fetchPrice",
        }),
        publicClient.readContract({
          address: TROVE_MANAGER_ADDRESS,
          abi: troveManagerAbi,
          functionName: "DECIMAL_PRECISION",
        }),
        getMusdDecimals(),
      ]);

    const collateralBtc = numeric(formatUnits(collateralRaw, NATIVE_DECIMALS));
    const debtMusd = numeric(formatUnits(debtRaw, musdDecimals));
    const btcPriceUsd = numeric(formatUnits(priceRaw, decimalPlaces(precision)));
    const troveActive = Number(statusRaw) === 1 && collateralRaw > 0n;
    const collateralValueUsd = collateralBtc * btcPriceUsd;
    const ltvPercent =
      troveActive && collateralValueUsd > 0
        ? (debtMusd / collateralValueUsd) * 100
        : 0;

    return {
      address,
      troveActive,
      collateralBtc,
      debtMusd,
      btcPriceUsd,
      collateralValueUsd,
      ltvPercent,
      liquidationLtvPercent: 90,
      distanceToLiquidationPercent: 90 - ltvPercent,
      level: levelFor(ltvPercent, troveActive),
      warnLtv: getThresholds().warn,
      dangerLtv: getThresholds().danger,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    throw new RpcFailure("RPC request failed");
  }
}

async function fetchHealthWithRetries(address: Address): Promise<HealthResponse> {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchHealth(address);
    } catch (error) {
      if (getRequestSignal()?.aborted || attempt === HEALTH_ATTEMPTS - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new RpcFailure("RPC request failed");
}

export async function getHealth(address: Address): Promise<ApiResult<HealthResponse>> {
  const key = address.toLowerCase();
  const cached = healthCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { value: cached.value, cache: "hit" };
  }
  try {
    const value = await fetchHealthWithRetries(address);
    setCache(healthCache, key, value, FRESH_CACHE_MS);
    setCache(lastGoodHealth, key, value, STALE_CACHE_MS);
    return { value, cache: "miss" };
  } catch (error) {
    const previous = lastGoodHealth.get(key);
    if (previous && previous.expiresAt > Date.now()) {
      return {
        value: { ...previous.value, stale: true },
        cache: "stale",
      };
    }
    if (error instanceof RpcFailure) throw error;
    throw new RpcFailure("RPC request failed");
  }
}

function decodeTransfer(log: Log, address: Address, decimals: number): TransferItem {
  const event = decodeEventLog({
    abi: musdAbi,
    eventName: "Transfer",
    data: log.data,
    topics: log.topics,
  });
  const incoming = event.args.to.toLowerCase() === address.toLowerCase();
  const txHash = log.transactionHash;
  const block = log.blockNumber;
  if (!txHash || block === null || log.logIndex === null) {
    throw new Error("Incomplete transfer log");
  }
  return {
    direction: incoming ? "IN" : "OUT",
    amount: formatUnits(event.args.value, decimals),
    counterparty: getAddress(incoming ? event.args.from : event.args.to),
    block: block.toString(),
    txHash,
    logIndex: log.logIndex,
    explorerLink: `${EXPLORER_URL}/tx/${txHash}`,
  };
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function queryLogs(
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const [sent, received] = await Promise.all([
    publicClient.getLogs({
      address: MUSD_ADDRESS,
      event: musdAbi[1],
      args: { from: address },
      fromBlock,
      toBlock,
    }),
    publicClient.getLogs({
      address: MUSD_ADDRESS,
      event: musdAbi[1],
      args: { to: address },
      fromBlock,
      toBlock,
    }),
  ]);
  const unique = new Map<string, Log>();
  for (const log of [...sent, ...received]) {
    unique.set(`${log.transactionHash}:${log.logIndex}`, log);
  }
  return [...unique.values()].sort((left, right) => {
    const blockDiff = (right.blockNumber ?? 0n) - (left.blockNumber ?? 0n);
    if (blockDiff !== 0n) return blockDiff > 0n ? 1 : -1;
    return (right.logIndex ?? 0) - (left.logIndex ?? 0);
  });
}

function getLookbackBlocks(): bigint {
  const raw = process.env.TRANSFERS_LOOKBACK_BLOCKS?.trim();
  if (!raw) return LOOKBACK_BLOCKS;
  if (!/^\d+$/.test(raw)) throw new Error("Invalid transfer lookback configuration");
  const blocks = BigInt(raw);
  if (blocks < 1n || blocks > MAX_LOOKBACK_BLOCKS) {
    throw new Error("Invalid transfer lookback configuration");
  }
  return blocks;
}

async function fetchTransfers(address: Address): Promise<TransfersResponse> {
  const deadline = Date.now() + TRANSFER_DEADLINE_MS;
  const lookbackBlocks = getLookbackBlocks();
  const partialResult = (): TransfersResponse => ({
    address,
    transfers: [],
    partial: true,
    updatedAt: new Date().toISOString(),
  });
  const initialReads = await beforeDeadline(
    Promise.all([publicClient.getBlockNumber(), getMusdDecimals()]),
    deadline,
  );
  if (!initialReads) return partialResult();
  const [latestBlock, decimals] = initialReads;
  const firstBlock = latestBlock >= lookbackBlocks - 1n
    ? latestBlock - lookbackBlocks + 1n
    : 0n;
  const chunks: Array<{ from: bigint; to: bigint }> = [];
  for (let cursor = latestBlock; cursor >= firstBlock;) {
    const from = cursor - firstBlock + 1n > LOG_CHUNK_SIZE
      ? cursor - LOG_CHUNK_SIZE + 1n
      : firstBlock;
    chunks.push({ from, to: cursor });
    cursor = from - 1n;
  }

  const results: TransferItem[] = [];
  let nextChunk = 0;
  let successfulChunks = 0;
  let failedChunk = false;
  let deadlineReached = false;
  const worker = async (): Promise<void> => {
    while (nextChunk < chunks.length && results.length < 10 && Date.now() < deadline) {
      const chunk = chunks[nextChunk++];
      if (!chunk) return;
      try {
        const logs = await beforeDeadline(
          queryLogs(address, chunk.from, chunk.to),
          deadline,
        );
        if (!logs) {
          failedChunk = true;
          deadlineReached = true;
          return;
        }
        successfulChunks += 1;
        results.push(...logs.map((log) => decodeTransfer(log, address, decimals)));
      } catch {
        failedChunk = true;
        return;
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(MAX_PARALLEL_TRANSFER_CHUNKS, chunks.length) },
    () => worker(),
  );
  const finished = await beforeDeadline(Promise.all(workers), deadline);
  const partial =
    !finished ||
    failedChunk ||
    nextChunk < chunks.length && results.length < 10;
  if (successfulChunks === 0) {
    if (deadlineReached || Date.now() >= deadline) return partialResult();
    throw new RpcFailure("RPC request failed");
  }

  const value: TransfersResponse = {
    address,
    transfers: results
      .sort((left, right) => {
        const blockDiff = BigInt(right.block) - BigInt(left.block);
        if (blockDiff !== 0n) return blockDiff > 0n ? 1 : -1;
        return right.logIndex - left.logIndex;
      })
      .slice(0, 10),
    partial,
    updatedAt: new Date().toISOString(),
  };
  return value;
}

export async function getTransfers(
  address: Address,
): Promise<ApiResult<TransfersResponse>> {
  const key = address.toLowerCase();
  const cached = transfersCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { value: cached.value, cache: "hit" };
  }
  try {
    const value = await fetchTransfers(address);
    if (value.partial && value.transfers.length === 0) {
      const previous = lastGoodTransfers.get(key);
      if (previous && previous.expiresAt > Date.now()) {
        return {
          value: { ...previous.value, stale: true },
          cache: "stale",
        };
      }
    }
    setCache(transfersCache, key, value, FRESH_CACHE_MS);
    if (!value.partial || value.transfers.length > 0) {
      setCache(lastGoodTransfers, key, value, STALE_CACHE_MS);
    }
    return { value, cache: "miss" };
  } catch (error) {
    const previous = lastGoodTransfers.get(key);
    if (previous && previous.expiresAt > Date.now()) {
      return {
        value: { ...previous.value, stale: true },
        cache: "stale",
      };
    }
    if (error instanceof RpcFailure) throw error;
    throw new RpcFailure("RPC request failed");
  }
}

export function logApiRequest(
  route: string,
  request: Request,
  startedAt: number,
  cache: CacheStatus = "miss",
): void {
  const address = new URL(request.url).searchParams.get("address");
  const prefix = address?.slice(0, 6) || "none";
  console.info(
    `[api] route=${route} address=${prefix} ms=${Date.now() - startedAt} cache=${cache}`,
  );
}

export function normalizeAddress(address: string): Address {
  return getAddress(address);
}
