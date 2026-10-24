import { createServer, type Server } from "node:http";
import { formatUnits, getAddress, type Address, type Log } from "viem";
import {
  EXPLORER_URL,
  getHealthAlertConfig,
  getTelegramConfig,
  getWatchAddress,
} from "./config.js";
import { publicClient } from "./client.js";
import {
  getMusdBalance,
  getMusdDecimals,
  getTransferLogs,
  LOG_CHUNK_SIZE,
  transferDetails,
} from "./musd.js";
import { loadState, saveState, type WatchState } from "./state.js";
import {
  getTelegramUpdates,
  sendTelegramMessage,
  type TelegramUpdate,
} from "./telegram.js";
import { getLoanHealth, type LoanHealth } from "./loan.js";
import type { HealthLevel } from "./state.js";
import { authorizeTelegramCommand, logError, logInfo, redact } from "./security.js";
import { validateEnvironment } from "./env.js";

const POLL_INTERVAL_MS = 10_000;
const MAX_RETRIES = 5;
const HEALTH_FAILURE_ALERT_MS = 10 * 60 * 1000;
const DRY_RUN = process.argv.includes("--dry-run");

let stopping = false;
let state: WatchState | undefined;
let simulatedLtv: number | undefined;
let simulatedHealthLevel: HealthLevel | undefined;
let wakePendingDelay: (() => void) | undefined;
let startedAt = Date.now();
let httpServer: Server | undefined;
const commandAbortController = new AbortController();
const commandAttempts = new Map<string, number[]>();

class RetryFailedError extends Error {}

function requestStop(): void {
  stopping = true;
  wakePendingDelay?.();
  commandAbortController.abort();
  httpServer?.close();
  logInfo("Shutdown requested; finishing the current block range.");
}

process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

async function withRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (stopping) throw error;
      logError(
        `${label}: ${errorSummary(error)}; attempt ${attempt}/${MAX_RETRIES}; ${
          attempt === MAX_RETRIES
            ? "no further retry"
            : `retry in ${2 ** (attempt - 1)}s`
        }`,
      );
      if (attempt < MAX_RETRIES) {
        await delay(1000 * 2 ** (attempt - 1));
      }
    }
  }
  throw new RetryFailedError(`${label}: ${errorSummary(lastError)}`);
}

function errorSummary(error: unknown): string {
  let message: string;
  if (
    typeof error === "object" &&
    error !== null &&
    "shortMessage" in error &&
    typeof error.shortMessage === "string"
  ) {
    message = error.shortMessage;
  } else if (error instanceof Error) {
    message = error.message.split(/\r?\n/, 1)[0] ?? "Unknown error";
  } else {
    message = "Unknown error";
  }
  return redact(message).replace(/\s+/g, " ").slice(0, 240);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (wakePendingDelay === finish) wakePendingDelay = undefined;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    wakePendingDelay = finish;
  });
}

function getSimulatedLtv(): number | undefined {
  const index = process.argv.indexOf("--simulate-ltv");
  if (index < 0) return undefined;
  const rawValue = process.argv[index + 1];
  const value = rawValue === undefined ? Number.NaN : Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--simulate-ltv requires a non-negative numeric value");
  }
  return value;
}

function getTelegramTestLtv(): number | undefined {
  const index = process.argv.indexOf("--telegram-test");
  if (index < 0) return undefined;
  const nextArgument = process.argv[index + 1];
  const value =
    nextArgument === undefined || nextArgument.startsWith("--")
      ? 85
      : Number(nextArgument);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--telegram-test LTV must be a non-negative number");
  }
  return value;
}

function eventId(log: Log): string {
  if (!log.transactionHash || log.logIndex === null) {
    throw new Error("Received a MUSD Transfer log without a transaction hash or log index");
  }
  return `${log.transactionHash}:${log.logIndex}`;
}

async function notify(
  log: Log,
  account: Address,
  decimals: number,
  send: ((text: string) => Promise<void>) | undefined,
): Promise<void> {
  const details = transferDetails(log, account, decimals);
  const txHash = log.transactionHash;
  if (!txHash) throw new Error("Received a MUSD Transfer log without a transaction hash");
  const message = [
    `${details.direction} ${details.amount} MUSD`,
    `Counterparty: ${shortAddress(details.counterparty)}`,
    `${EXPLORER_URL}/tx/${txHash}`,
  ].join("\n");

  if (!send) {
    logInfo(`[dry-run]\n${message}`);
  } else {
    await withRetry("Telegram notification", () => send(message));
  }
}

function shortAddress(address: Address): string {
  const normalized = getAddress(address);
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function healthLevelFor(
  ltv: number,
  warnLtv: number,
  dangerLtv: number,
): HealthLevel {
  if (ltv >= dangerLtv) return "DANGER";
  if (ltv >= warnLtv) return "WARN";
  return "OK";
}

function healthMessage(level: HealthLevel, health: LoanHealth): string {
  const headline =
    level === "DANGER"
      ? "DANGER: loan health is at high risk"
      : level === "WARN"
        ? "WARNING: loan health needs attention"
        : "Loan health is back to safe";
  return [
    headline,
    `LTV: ${health.ltvPercent.toFixed(2)}%`,
    `Collateral: ${health.collateralBtc} BTC`,
    `Debt: ${health.debtMusd} MUSD`,
    `BTC price: $${health.btcPriceUsd}`,
    `Distance to liquidation: ${health.distanceToLiquidationPercent.toFixed(2)} percentage points`,
    level === "OK"
      ? "Tip: keep a buffer by adding collateral or repaying MUSD if market conditions change."
      : "Tip: add collateral or repay MUSD to lower your LTV.",
  ].join("\n");
}

async function notifyHealth(
  level: HealthLevel,
  health: LoanHealth,
  send: ((text: string) => Promise<void>) | undefined,
): Promise<void> {
  const message = healthMessage(level, health);
  if (!send) {
    logInfo(`[dry-run]\n${message}`);
  } else {
    await withRetry("Telegram health alert", () => send(message));
  }
}

async function notifyText(
  text: string,
  send: ((text: string) => Promise<void>) | undefined,
  label: string,
): Promise<void> {
  if (!send) {
    logInfo(`[dry-run]\n${text}`);
  } else {
    await withRetry(label, () => send(text));
  }
}

function commandLevel(ltv: number): "SAFE" | "WARNING" | "DANGER" {
  const { warnLtv, dangerLtv } = getHealthAlertConfig();
  if (ltv >= dangerLtv) return "DANGER";
  if (ltv >= warnLtv) return "WARNING";
  return "SAFE";
}

function healthCommandMessage(health: LoanHealth): string {
  return [
    `Level: ${commandLevel(health.ltvPercent)}`,
    `Trove active: ${health.troveActive}`,
    `LTV: ${health.ltvPercent.toFixed(2)}%`,
    `Collateral: ${health.collateralBtc} BTC`,
    `Debt: ${health.debtMusd} MUSD`,
    `BTC price: $${health.btcPriceUsd}`,
    `Distance to liquidation: ${health.distanceToLiquidationPercent.toFixed(2)} percentage points`,
  ].join("\n");
}

async function handleTelegramCommand(
  update: TelegramUpdate,
  token: string,
  chatId: string,
  account: Address,
): Promise<void> {
  const command = update.text?.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  if (!command || !["/health", "/balance", "/status", "/help"].includes(command)) return;
  if (!state) throw new Error("Watch state is not initialized");

  let reply: string;
  if (command === "/health") {
    try {
      const health = await withRetry("Telegram /health RPC", () => getLoanHealth(account));
      reply = healthCommandMessage(health);
    } catch (error) {
      reply = `Could not read loan health: RPC error: ${errorSummary(error)}`;
    }
  } else if (command === "/balance") {
    try {
      const [nativeBalance, musdBalance, decimals] = await withRetry(
        "Telegram /balance RPC",
        async () =>
          Promise.all([
            publicClient.getBalance({ address: account }),
            getMusdBalance(account),
            getMusdDecimals(),
          ]),
      );
      reply = [
        `BTC balance: ${formatUnits(nativeBalance, 18)} BTC`,
        `MUSD balance: ${formatUnits(musdBalance, decimals)} MUSD`,
      ].join("\n");
    } catch (error) {
      reply = `Could not read balances: RPC error: ${errorSummary(error)}`;
    }
  } else if (command === "/status") {
    reply = [
      `Watching MUSD transfers and loan health for ${getAddress(account)}`,
      `Last processed block: ${state.lastProcessedBlock}`,
      `Health level: ${state.healthLevel ?? "OK"}`,
      `Uptime: ${Math.floor((Date.now() - startedAt) / 1000)} seconds`,
    ].join("\n");
  } else {
    reply = "Commands: /health, /balance, /status, /help";
  }

  await withRetry("Telegram command reply", () =>
    sendTelegramMessage(token, chatId, reply),
  );
}

async function pollTelegramCommands(
  token: string,
  chatId: string,
  account: Address,
): Promise<void> {
  let offset = state?.telegramUpdateOffset;
  while (!stopping) {
    let updates: TelegramUpdate[];
    try {
      updates = await withRetry("Telegram getUpdates", () =>
        getTelegramUpdates(token, offset, commandAbortController.signal),
      );
    } catch {
      if (stopping) return;
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    for (const update of updates) {
      if (stopping) return;
      try {
        const allowedSenderIds =
          process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",").map((id) => id.trim()) ?? [
            chatId,
          ];
        if (
          authorizeTelegramCommand(update, chatId, allowedSenderIds) &&
          update.senderId !== undefined &&
          !isRateLimited(update.senderId)
        ) {
          await handleTelegramCommand(update, token, chatId, account);
        }
        offset = update.updateId + 1;
        if (state) {
          state.telegramUpdateOffset = offset;
          await saveState(state);
        }
      } catch (error) {
        if (stopping) return;
        if (!(error instanceof RetryFailedError)) {
          logError(
            `Telegram command update ${update.updateId}: ${errorSummary(error)}; update will retry`,
          );
        }
        await delay(1000);
        break;
      }
    }

    function isRateLimited(senderId: number): boolean {
      const now = Date.now();
      const key = String(senderId);
      const recent = (commandAttempts.get(key) ?? []).filter(
        (timestamp) => now - timestamp < 60_000,
      );
      if (recent.length >= 10) {
        commandAttempts.set(key, recent);
        return true;
      }
      recent.push(now);
      commandAttempts.set(key, recent);
      return false;
    }
  }
}

async function checkLoanHealth(
  account: Address,
  decimals: number,
  send: ((text: string) => Promise<void>) | undefined,
): Promise<void> {
  if (!state) throw new Error("Watch state is not initialized");
  const alertConfig = getHealthAlertConfig();
  let health: LoanHealth;
  try {
    health = await withRetry("Loan health RPC", () => getLoanHealth(account, decimals));
  } catch {
    await recordHealthFailure(send);
    return;
  }
  await recordHealthSuccess(send);
  if (simulatedLtv !== undefined) {
    health.ltvPercent = simulatedLtv;
    health.distanceToLiquidationPercent =
      health.liquidationLtvPercent - simulatedLtv;
  }

  const wasInitialized =
    simulatedHealthLevel !== undefined || state.healthLevel !== undefined;
  const previous = simulatedHealthLevel ?? state.healthLevel ?? "OK";
  const target = healthLevelFor(
    health.ltvPercent,
    alertConfig.warnLtv,
    alertConfig.dangerLtv,
  );
  logInfo(
    `Health poll: ${target} (LTV ${health.ltvPercent.toFixed(2)}%; collateral ${health.collateralBtc} BTC; debt ${health.debtMusd} MUSD)`,
  );

  let next: HealthLevel;
  if (health.ltvPercent < alertConfig.warnLtv - 3) {
    next = "OK";
  } else if (target !== "OK") {
    next = target;
  } else if (previous !== "OK") {
    next = "WARN";
  } else {
    next = "OK";
  }

  const rank = (level: HealthLevel): number =>
    level === "OK" ? 0 : level === "WARN" ? 1 : 2;
  if (rank(next) > rank(previous)) {
    await notifyHealth(next, health, send);
  } else if (previous !== "OK" && next === "OK") {
    await notifyHealth("OK", health, send);
  }

  if (simulatedLtv !== undefined) {
    simulatedHealthLevel = next;
    if (next !== previous) {
      logInfo(`Simulated health level: ${previous} -> ${next}.`);
    }
    return;
  }

  if (next !== state.healthLevel) {
    state.healthLevel = next;
    await saveState(state);
    logInfo(
      wasInitialized
        ? `Health level changed: ${previous} -> ${next}.`
        : `Initialized persisted health level to ${next}.`,
    );
  }
}

async function recordHealthFailure(
  send: ((text: string) => Promise<void>) | undefined,
): Promise<void> {
  if (!state) return;
  if (state.healthFailureSinceMs === undefined) {
    state.healthFailureSinceMs = Date.now();
    state.healthFailureAlerted = false;
    await saveState(state);
  }

  const failedFor = Date.now() - state.healthFailureSinceMs;
  if (failedFor < HEALTH_FAILURE_ALERT_MS || state.healthFailureAlerted) return;

  state.healthFailureAlerted = true;
  await saveState(state);
  await notifyText(
    "Health check is failing: RPC unreachable",
    send,
    "Telegram RPC-failure alert",
  );
}

async function recordHealthSuccess(
  send: ((text: string) => Promise<void>) | undefined,
): Promise<void> {
  if (!state || state.healthFailureSinceMs === undefined) return;
  if (state.healthFailureAlerted) {
    await notifyText(
      "Health check recovered",
      send,
      "Telegram RPC-recovered alert",
    );
  }
  delete state.healthFailureSinceMs;
  delete state.healthFailureAlerted;
  await saveState(state);
}

async function runTelegramTest(
  account: Address,
  ltv: number,
): Promise<void> {
  const { token, chatId } = getTelegramConfig();
  const decimals = await withRetry("MUSD decimals RPC", getMusdDecimals);
  const health = await withRetry("Loan health RPC", () =>
    getLoanHealth(account, decimals),
  );
  const simulatedHealth: LoanHealth = {
    ...health,
    ltvPercent: ltv,
    distanceToLiquidationPercent: health.liquidationLtvPercent - ltv,
  };
  const message = [
    "TEST (simulated, not your real loan)",
    healthMessage("DANGER", simulatedHealth),
  ].join("\n");
  await withRetry("Telegram test message", () =>
    sendTelegramMessage(token, chatId, message),
  );
  logInfo("Sent one Telegram test alert.");
}

function startHealthServer(): void {
  const rawPort = process.env.PORT?.trim();
  if (!rawPort) return;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  httpServer = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: true,
        lastBlock: state?.lastProcessedBlock.toString() ?? null,
        level: state?.healthLevel ?? "OK",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      }),
    );
  });
  httpServer.requestTimeout = 10_000;
  httpServer.headersTimeout = 5_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.on("error", (error) => {
    logError(`Health HTTP server: ${errorSummary(error)}`);
  });
  httpServer.listen(port, "0.0.0.0", () => {
    logInfo(`Health HTTP server listening on port ${port}.`);
  });
}

async function handleRange(
  fromBlock: bigint,
  toBlock: bigint,
  account: Address,
  decimals: number,
  send: ((text: string) => Promise<void>) | undefined,
): Promise<void> {
  if (!state) throw new Error("Watch state is not initialized");
  if (fromBlock > toBlock) return;

  const ids = new Set(state.recentIds);
  const logs = await withRetry("MUSD log query", () =>
    getTransferLogs(account, fromBlock, toBlock),
  );
  for (const log of logs) {
    const id = eventId(log);
    if (ids.has(id)) continue;
    await notify(log, account, decimals, send);
    ids.add(id);
    state.recentIds.push(id);
    if (state.recentIds.length > 1000) state.recentIds.shift();
  }

  state.lastProcessedBlock = toBlock;
  await saveState(state);
  logInfo(`Processed blocks ${fromBlock}-${toBlock}`);
}

async function main(): Promise<void> {
  startedAt = Date.now();
  validateEnvironment();
  const telegramTestLtv = getTelegramTestLtv();
  if (telegramTestLtv !== undefined) {
    if (DRY_RUN) {
      throw new Error("--telegram-test sends a real message and cannot be combined with --dry-run");
    }
    await runTelegramTest(getWatchAddress(), telegramTestLtv);
    return;
  }

  simulatedLtv = getSimulatedLtv();
  if (simulatedLtv !== undefined && !DRY_RUN) {
    throw new Error("--simulate-ltv requires --dry-run; simulated alerts are never sent to Telegram");
  }
  const account = getWatchAddress();
  const healthAlertConfig = getHealthAlertConfig();
  const telegram = DRY_RUN ? undefined : getTelegramConfig();
  const send = telegram
    ? (text: string) => sendTelegramMessage(telegram.token, telegram.chatId, text)
    : undefined;
  const decimals = await withRetry("MUSD decimals RPC", getMusdDecimals);
  const latestBlock = await withRetry("Latest block query", () =>
    publicClient.getBlockNumber(),
  );

  state = await loadState(latestBlock);
  const commandPolling = telegram
    ? pollTelegramCommands(telegram.token, telegram.chatId, account)
    : undefined;
  logInfo(
    `${DRY_RUN ? "Dry run" : "Watching"} MUSD transfers for ${getAddress(account)} from block ${state.lastProcessedBlock + 1n}`,
  );
  if (simulatedLtv !== undefined) {
    logInfo("Simulation mode: transfer polling and state writes are disabled.");
    logInfo(`[simulation] Using LTV ${simulatedLtv}% for health alert decisions.`);
  }
  startHealthServer();
  let nextHealthPollAt = 0;

  while (!stopping) {
    if (simulatedLtv === undefined) {
      try {
        const latest = await withRetry("Latest block query", () =>
          publicClient.getBlockNumber(),
        );
        let start = state.lastProcessedBlock + 1n;
        while (!stopping && start <= latest) {
          const end =
            start + LOG_CHUNK_SIZE - 1n > latest
              ? latest
              : start + LOG_CHUNK_SIZE - 1n;
          await handleRange(start, end, account, decimals, send);
          start = end + 1n;
        }
      } catch {
        if (stopping) break;
      }
    }

    if (!stopping && Date.now() >= nextHealthPollAt) {
      try {
        await checkLoanHealth(account, decimals, send);
      } catch (error) {
        if (!(error instanceof RetryFailedError)) {
          logError(`Health alert processing: ${errorSummary(error)}`);
        }
      }
      nextHealthPollAt = Date.now() + healthAlertConfig.pollSeconds * 1000;
    }
    if (!stopping) await delay(POLL_INTERVAL_MS);
  }

  if (state && simulatedLtv === undefined) await saveState(state);
  await commandPolling;
  logInfo("Watcher stopped cleanly.");
}

main().catch((error: unknown) => {
  if (!(error instanceof RetryFailedError)) {
    logError(`Watcher stopped: ${errorSummary(error)}`);
  }
  process.exitCode = 1;
});
