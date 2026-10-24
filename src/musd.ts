import {
  decodeEventLog,
  formatUnits,
  getAddress,
  parseAbi,
  type Address,
  type Log,
} from "viem";
import { MUSD_ADDRESS } from "./config.js";
import { publicClient } from "./client.js";

export const musdAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const LOG_CHUNK_SIZE = 2000n;

let decimalsPromise: Promise<number> | undefined;

export async function getMusdDecimals(): Promise<number> {
  if (!decimalsPromise) {
    decimalsPromise = publicClient
      .readContract({
        address: MUSD_ADDRESS,
        abi: musdAbi,
        functionName: "decimals",
      })
      .then(Number)
      .catch((error: unknown) => {
        decimalsPromise = undefined;
        throw error;
      });
  }
  return decimalsPromise;
}

export async function getMusdBalance(account: Address): Promise<bigint> {
  return publicClient.readContract({
    address: MUSD_ADDRESS,
    abi: musdAbi,
    functionName: "balanceOf",
    args: [account],
  });
}

export async function getTransferLogs(
  account: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const logs: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end =
      start + LOG_CHUNK_SIZE - 1n > toBlock
        ? toBlock
        : start + LOG_CHUNK_SIZE - 1n;
    const [sent, received] = await Promise.all([
      publicClient.getLogs({
        address: MUSD_ADDRESS,
        event: musdAbi[2],
        args: { from: account },
        fromBlock: start,
        toBlock: end,
      }),
      publicClient.getLogs({
        address: MUSD_ADDRESS,
        event: musdAbi[2],
        args: { to: account },
        fromBlock: start,
        toBlock: end,
      }),
    ]);
    logs.push(...sent, ...received);
  }

  const unique = new Map<string, Log>();
  for (const log of logs) {
    unique.set(`${log.transactionHash}:${log.logIndex}`, log);
  }
  return [...unique.values()].sort((a, b) => {
    const blockOrder = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
    if (blockOrder !== 0n) return blockOrder < 0n ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

export function transferDetails(log: Log, account: Address, decimals: number) {
  const event = decodeEventLog({
    abi: musdAbi,
    eventName: "Transfer",
    data: log.data,
    topics: log.topics,
  });

  const isIncoming = event.args.to.toLowerCase() === account.toLowerCase();
  const counterparty = isIncoming ? event.args.from : event.args.to;
  return {
    direction: isIncoming ? "IN" : "OUT",
    amount: formatUnits(event.args.value, decimals),
    counterparty: getAddress(counterparty),
  } as const;
}
