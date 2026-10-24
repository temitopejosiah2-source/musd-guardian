import { logError, logInfo } from "./security.js";
import { validateEnvironment } from "./env.js";
import { formatUnits, getAddress } from "viem";
import { EXPLORER_URL, getStartLookbackBlocks, getWatchAddress } from "./config.js";
import { publicClient } from "./client.js";
import {
  getMusdBalance,
  getMusdDecimals,
  getTransferLogs,
  transferDetails,
} from "./musd.js";

async function main(): Promise<void> {
  validateEnvironment();
  const account = getWatchAddress();
  const decimals = await getMusdDecimals();
  const [nativeBalance, musdBalance, latestBlock] = await Promise.all([
    publicClient.getBalance({ address: account }),
    getMusdBalance(account),
    publicClient.getBlockNumber(),
  ]);

  logInfo(`Address: ${getAddress(account)}`);
  logInfo(`BTC balance: ${formatUnits(nativeBalance, 18)} BTC`);
  logInfo(`MUSD balance: ${formatUnits(musdBalance, decimals)} MUSD`);
  logInfo(`Latest block: ${latestBlock}`);

  const lookback = getStartLookbackBlocks();
  const fromBlock = latestBlock >= lookback - 1n ? latestBlock - lookback + 1n : 0n;
  const logs = await getTransferLogs(account, fromBlock, latestBlock);
  logInfo(`\nLast ${Math.min(logs.length, 10)} MUSD transfers (lookback from block ${fromBlock}):`);
  for (const log of logs.slice(-10).reverse()) {
    const details = transferDetails(log, account, decimals);
    const txHash = log.transactionHash;
    if (!txHash) throw new Error("Received a MUSD Transfer log without a transaction hash");
    logInfo(
      `${details.direction} ${details.amount} MUSD | counterparty ${details.counterparty} | block ${log.blockNumber} | tx ${txHash} | ${EXPLORER_URL}/tx/${txHash}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  logError(`Balance query failed: ${message}`);
  process.exitCode = 1;
});
