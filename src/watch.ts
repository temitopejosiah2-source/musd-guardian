import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import { getHealthAlertConfig, getWatchAddress } from "./config.js";
import { publicClient } from "./client.js";
import { getMusdDecimals, LOG_CHUNK_SIZE } from "./musd.js";
import { getLoanHealth, type LoanHealth } from "./loan.js";
import { buildSimulatedAlert, runHealthCycle, processTransferRange, transitionLevel, processPriceDropAlerts } from "./monitor.js";
import type { MessageSender } from "./monitor.js";
import { OutboundQueue } from "./outbound.js";
import { logError, logInfo, redact, registerChatId } from "./security.js";
import { createStore, type Store } from "./store/index.js";
import { MemoryStore } from "./store/memory.js";
import { normalizeAddress } from "./store/validation.js";
import { BotCommands, limitsFromEnvironment } from "./bot.js";
import {
  answerTelegramCallback,
  getTelegramUpdates,
  processTelegramUpdates,
  sendTelegramMessage,
} from "./telegram.js";
import { ltvAtPrice } from "./risk.js";
import { validateEnvironment } from "./env.js";
import {
  ExponentialBackoff,
  retryLockRenewal,
  ServiceStatusTracker,
  stopIfLockLost,
  type ServiceName,
} from "./resilience.js";

const DRY_RUN = process.argv.includes("--dry-run");
const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_INTERVAL_MS = 15_000;
const LOCK_RENEW_TIMEOUT_MS = 10_000;
let stopping = false;
let lastCycleAt = 0;
let startedAt = Date.now();
let latestProcessedBlock: string | null = null;
let httpServer: Server | undefined;
let commandController: AbortController | undefined;
let outboundQueue: OutboundQueue | undefined;
let wakeStop: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => { wakeStop = resolve; });
const services = new ServiceStatusTracker(logInfo, logInfo);
const redisFailures = new WeakSet<object>();

function isRedisStoreSelected(): boolean {
  const configured = process.env.STORE?.trim();
  return configured === "redis" ||
    (!configured && Boolean(
      process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
    ));
}

function wasRedisFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && redisFailures.has(error);
}

function requestStop(): void {
  if (stopping) return;
  stopping = true;
  wakeStop?.();
  commandController?.abort();
  outboundQueue?.stop();
  httpServer?.close();
  logInfo("Shutdown requested.");
}

process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitOrStop(milliseconds: number): Promise<void> {
  return Promise.race([delay(milliseconds), stopped]);
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return redact(message).replace(/\s+/g, " ").slice(0, 240);
}

async function waitForLock(store: Store, instanceId: string): Promise<void> {
  const backoff = new ExponentialBackoff();
  while (!stopping) {
    try {
      if (await store.acquireLock(instanceId, LOCK_TTL_MS)) {
        logInfo("Poller lock acquired.");
        return;
      }
      backoff.reset();
      await waitOrStop(5000);
    } catch {
      services.failed("redis");
      await waitOrStop(backoff.nextDelay());
    }
  }
}

async function getInitialBlockNumber(): Promise<bigint> {
  const backoff = new ExponentialBackoff();
  while (!stopping) {
    try {
      const block = await publicClient.getBlockNumber();
      services.succeeded("rpc");
      return block;
    } catch {
      services.failed("rpc");
      await waitOrStop(backoff.nextDelay());
    }
  }
  return 0n;
}

function startLockRenewal(store: Store, instanceId: string): ReturnType<typeof setInterval> {
  let lastSuccessAt = Date.now();
  let running = false;
  return setInterval(() => {
    if (stopping || running) return;
    running = true;
    void retryLockRenewal(
      async () => {
        const result = await store.renewLock(instanceId, LOCK_TTL_MS);
        return result;
      },
      {
        lastSuccessAt,
        timeoutMs: LOCK_RENEW_TIMEOUT_MS,
        ttlMs: LOCK_TTL_MS,
        wait: waitOrStop,
      },
    ).then((result) => {
      if (result === "renewed") {
        lastSuccessAt = Date.now();
      } else if (result === "lost") {
        logError("Poller lock lost; stopping polling with exit code 1.");
        stopIfLockLost(result, requestStop, (code) => { process.exitCode = code; });
      }
    }).catch(() => {
      if (!stopping) services.failed("redis");
    }).finally(() => { running = false; });
  }, LOCK_RENEW_INTERVAL_MS);
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
    const age = lastCycleAt === 0 ? 301 : Math.floor((Date.now() - lastCycleAt) / 1000);
    const body = {
      ok: age <= 300,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      lastBlock: latestProcessedBlock,
      lastCycleAgeSeconds: age,
      services: services.snapshot(),
    };
    response.writeHead(body.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  httpServer.requestTimeout = 10_000;
  httpServer.headersTimeout = 5_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.on("error", (error) => logError(`Health HTTP server error: ${errorSummary(error)}`));
  httpServer.listen(port, "0.0.0.0", () => logInfo(`Health HTTP server listening on port ${port}.`));
}

async function initializeStore(store: Store, latestBlock: bigint): Promise<void> {
  const subscriptions = await store.getAllSubscriptions();
  for (const chatId of Object.keys(subscriptions)) registerChatId(chatId);
  if (
    Object.keys(subscriptions).length === 0 &&
    Number(process.env.SIMULATE_RPC_OUTAGE_MS ?? 0) === 0
  ) {
    const legacyAddress = process.env.WATCH_ADDRESS?.trim();
    const ownerChat = process.env.TELEGRAM_CHAT_ID?.trim();
    if (legacyAddress && ownerChat) {
      const address = normalizeAddress(legacyAddress);
      await store.addSubscription(ownerChat, { address: address.toLowerCase() as Address }, limitsFromEnvironment());
      logInfo("Migrated the configured owner subscription.");
    }
  }
  if (await store.getLastProcessedBlock() === undefined) {
    await store.setLastProcessedBlock(latestBlock);
  }
}

function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  return token;
}

async function runTelegramTest(store: Store): Promise<void> {
  if (DRY_RUN) throw new Error("--telegram-test sends a real message and cannot be combined with --dry-run");
  const token = getToken();
  const address = getWatchAddress();
  const health = await getLoanHealth(address);
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("--telegram-test requires TELEGRAM_CHAT_ID");
  const testArg = process.argv.indexOf("--telegram-test");
  const ltv = testArg >= 0 && process.argv[testArg + 1] && !process.argv[testArg + 1]?.startsWith("--")
    ? Number(process.argv[testArg + 1])
    : 85;
  const settings = await store.getSettings(chatId);
  const { message, keyboard } = buildSimulatedAlert(health, ltv, settings, address);
  const queue = new OutboundQueue(
    (targetChat, text, replyMarkup) => sendTelegramMessage(token, targetChat, text, replyMarkup),
    (targetChat) => store.deleteChat(targetChat),
  );
  await queue.sendMessage(chatId, message, keyboard);
  await queue.flush();
  await store.flush();
  logInfo("Sent one Telegram test alert.");
}

async function runDryRunDemo(store: Store): Promise<void> {
  const demoAddress = normalizeAddress("0x0000000000000000000000000000000000000001");
  const demoChatId = "987654321";
  const simulatedArg = process.argv.indexOf("--simulate-ltv");
  const simulatedLtv = simulatedArg >= 0 ? Number(process.argv[simulatedArg + 1]) : 85;
  const priceArg = process.argv.indexOf("--simulate-price");
  const simulatedPrice = priceArg >= 0 ? Number(process.argv[priceArg + 1]) : undefined;
  if (!Number.isFinite(simulatedLtv) || simulatedLtv < 0) {
    throw new Error("--simulate-ltv requires a non-negative numeric value");
  }
  if (priceArg >= 0 && (!Number.isFinite(simulatedPrice) || (simulatedPrice ?? 0) <= 0)) {
    throw new Error("--simulate-price requires a positive numeric value");
  }
  const baselinePrice = 100_000;
  const price = simulatedPrice ?? baselinePrice;
  const debtMusd = simulatedLtv * baselinePrice / 100;
  const currentLtv = ltvAtPrice(debtMusd, 1, price) ?? 0;
  const fakeHealth: LoanHealth = {
    collateralBtc: 1,
    debtMusd,
    btcPriceUsd: price,
    collateralValueUsd: price,
    ltvPercent: currentLtv,
    liquidationLtvPercent: 90,
    distanceToLiquidationPercent: 90 - simulatedLtv,
    troveActive: true,
    rawValues: {
      collateral: "1",
      debt: String(debtMusd),
      btcPrice: String(price),
      decimalPrecision: "1",
      troveStatus: 1,
      musdDecimals: 18,
      collateralDecimals: 18,
      priceDecimals: 0,
    },
  };
  const commands = new BotCommands({
    store,
    send: async (_chatId, text) => logInfo(`TEST (dry-run)\n${text}`),
    getHealth: async () => fakeHealth,
    getPriceStatus: async () => {
      const sample = (await store.getPriceSamples()).at(-1);
      return sample
        ? `Oracle price $${sample.price.toFixed(1)} sampled ${Math.floor((Date.now() - sample.t) / 1000)} seconds ago.`
        : "No recent oracle price sample is available.";
    },
    answerCallback: (callbackId, text) => answerTelegramCallback(getToken(), callbackId, text),
  });
  const makeUpdate = (text: string) => ({
    updateId: 1,
    chatId: Number(demoChatId),
    chatType: "private",
    senderId: Number(demoChatId),
    senderIsBot: false,
    text,
  });
  await commands.handle(makeUpdate(`/watch ${demoAddress} demo`));
  await commands.handle(makeUpdate("/list"));
  const settings = await store.getSettings(demoChatId);
  const prior = { level: "SAFE" as const, troveActive: true };
  const next = transitionLevel(currentLtv, prior, settings.monitorLtv, settings.warnLtv, settings.dangerLtv);
  await store.setLevel(demoChatId, demoAddress, { level: next, troveActive: true, health: fakeHealth });
  logInfo(`TEST (dry-run) Health level changed: ${prior.level} -> ${next}.`);
  if (priceArg >= 0) {
    const now = Date.now();
    await store.appendPriceSample({ t: now - 60_000, price: baselinePrice }, 300);
    await store.appendPriceSample({ t: now, price }, 300);
    await processPriceDropAlerts(
      store,
      async (_chatId, text) => logInfo(`TEST (dry-run)\n${text}`),
      [demoAddress],
      now,
    );
  }
  logInfo("Dry-run scenario complete; no RPC or Telegram requests were made.");
}

async function pollCommands(
  token: string,
  store: Store,
  queue: OutboundQueue,
  controller: AbortController,
): Promise<void> {
  const bot = new BotCommands({
    store,
    send: (chatId, text) => queue.sendMessage(chatId, text),
    ...(process.env.ADMIN_CHAT_ID ? { adminChatId: process.env.ADMIN_CHAT_ID } : {}),
    answerCallback: (callbackId, text) => answerTelegramCallback(token, callbackId, text),
    getPriceStatus: async () => {
      const sample = (await store.getPriceSamples()).at(-1);
      if (!sample) return "No oracle price sample is available yet.";
      const age = Math.max(0, Math.floor((Date.now() - sample.t) / 1000));
      const maximumAge = Number(process.env.PRICE_MAX_AGE_SECONDS ?? 600);
      return age > maximumAge
        ? `Oracle price is stale (${age} seconds old; maximum ${maximumAge}). Price alerts are paused.`
        : `Oracle price: $${sample.price.toFixed(1)} (${age} seconds old).`;
    },
    getAdminStatus: async () => {
      const metrics = await store.getMetrics();
      const lastBlock = await store.getLastProcessedBlock();
      const age = lastCycleAt ? Math.floor((Date.now() - lastCycleAt) / 1000) : "not yet";
      return [
        `Chats: ${metrics.chatCount}`,
        `Addresses: ${metrics.addressCount}`,
        `Last block: ${lastBlock?.toString() ?? "not set"}`,
        `Last health cycle age: ${age} seconds`,
        ...serviceStatusLines(),
        `Redis commands used: ${metrics.redisCommands}`,
        `Uptime: ${Math.floor((Date.now() - startedAt) / 1000)} seconds`,
        `Errors in the last hour: ${metrics.errorsLastHour}`,
      ];
    },
  });
  let offset: number | undefined;
  let offsetLoaded = false;
  const backoff = new ExponentialBackoff();
  while (!stopping) {
    try {
      if (!offsetLoaded) {
        offset = await store.getTelegramOffset();
        offsetLoaded = true;
      }
      const updates = await getTelegramUpdates(token, offset, controller.signal);
      offset = await processTelegramUpdates(updates, offset, async (update) => {
        if (stopping) return;
        await bot.handle(update);
      }, (nextOffset) => store.setTelegramOffset(nextOffset), (nextOffset) => { offset = nextOffset; });
      services.succeeded("telegram");
      backoff.reset();
    } catch (error) {
      if (stopping) return;
      services.failed(wasRedisFailure(error) ? "redis" : "telegram");
      try { await store.recordError(); } catch { /* Redis status is tracked by the store wrapper. */ }
      await waitOrStop(backoff.nextDelay());
    }
  }
}

async function pollTransfers(store: Store, send: MessageSender): Promise<void> {
  const simulationMs = Number(process.env.SIMULATE_RPC_OUTAGE_MS ?? 0);
  if (simulationMs > 0) {
    if (Date.now() - startedAt < simulationMs) throw new Error("Simulated RPC outage");
    return;
  }
  const latest = await publicClient.getBlockNumber();
  const confirmedThrough = latest > 2n ? latest - 2n : 0n;
  const last = await store.getLastProcessedBlock();
  if (last === undefined) {
    await store.setLastProcessedBlock(latest);
    latestProcessedBlock = latest.toString();
    return;
  }
  let from = last + 1n;
  if (from > confirmedThrough) return;
  const decimals = await getMusdDecimals();
  while (!stopping && from <= confirmedThrough) {
    const to = from + LOG_CHUNK_SIZE - 1n < confirmedThrough
      ? from + LOG_CHUNK_SIZE - 1n
      : confirmedThrough;
    await processTransferRange(store, send, from, to, undefined, decimals);
    from = to + 1n;
    latestProcessedBlock = (from - 1n).toString();
  }
}

async function poller(
  store: Store,
  send: MessageSender,
  healthPollMs: number,
): Promise<void> {
  const sampleSeconds = Number(process.env.PRICE_SAMPLE_SECONDS ?? 300);
  if (!Number.isInteger(sampleSeconds) || sampleSeconds < 1) {
    throw new Error("PRICE_SAMPLE_SECONDS must be a positive integer");
  }
  const transferBackoff = new ExponentialBackoff();
  const transferLoop = async () => {
    while (!stopping) {
      try {
        await pollTransfers(store, send);
        services.succeeded("rpc");
        transferBackoff.reset();
        await waitOrStop(10_000);
      } catch (error) {
        services.failed(wasRedisFailure(error) ? "redis" : "rpc");
        try { await store.recordError(); } catch { /* Redis status is tracked by the store wrapper. */ }
        await waitOrStop(transferBackoff.nextDelay());
      }
    }
  };
  const healthBackoff = new ExponentialBackoff();
  const healthLoop = async () => {
    while (!stopping) {
      try {
        const cycle = await runHealthCycle(store, send);
        if (cycle.failedChecks > 0) throw new Error("One or more loan health checks failed");
        if (cycle.totalChecks > 0) services.succeeded("rpc");
        if (cycle.sample) {
          const samples = await store.getPriceSamples();
          const previous = samples.at(-1);
          if (!previous || cycle.sample.t - previous.t >= sampleSeconds * 1000) {
            await store.appendPriceSample(cycle.sample, 300);
            await processPriceDropAlerts(store, send, cycle.freshAddresses, cycle.sample.t);
          }
        }
        lastCycleAt = Date.now();
        healthBackoff.reset();
        await waitOrStop(healthPollMs);
      } catch (error) {
        services.failed(wasRedisFailure(error) ? "redis" : "rpc");
        try { await store.recordError(); } catch { /* Redis status is tracked by the store wrapper. */ }
        await waitOrStop(healthBackoff.nextDelay());
      }
    }
  };
  await Promise.all([transferLoop(), healthLoop()]);
}

async function main(): Promise<void> {
  startedAt = Date.now();
  validateEnvironment();
  if (DRY_RUN && process.argv.includes("--telegram-test")) {
    throw new Error("--telegram-test sends a real message and cannot be combined with --dry-run");
  }
  const baseStore = DRY_RUN ? new MemoryStore() : await createStoreResiliently();
  const store = trackStore(baseStore);
  if (DRY_RUN) {
    await runDryRunDemo(store);
    await store.flush();
    return;
  }
  if (process.argv.includes("--telegram-test")) {
    await runTelegramTest(store);
    return;
  }
  if (process.argv.includes("--simulate-ltv") || process.argv.includes("--simulate-price")) {
    throw new Error("--simulate-ltv and --simulate-price require --dry-run; simulated alerts are never sent to Telegram");
  }
  const { pollSeconds } = getHealthAlertConfig();
  const token = getToken();
  startHealthServer();
  const latestBlock = Number(process.env.SIMULATE_RPC_OUTAGE_MS ?? 0) > 0
    ? 0n
    : await getInitialBlockNumber();
  await initializeStoreResiliently(store, latestBlock);
  if (stopping) return;
  latestProcessedBlock = (await store.getLastProcessedBlock())?.toString() ?? null;
  const instanceId = randomUUID();
  await waitForLock(store, instanceId);
  if (stopping) {
    await store.releaseLock(instanceId);
    return;
  }
  const renewal = startLockRenewal(store, instanceId);
  const queue = outboundQueue = new OutboundQueue(
    (chatId, text, replyMarkup) => sendTelegramMessage(token, chatId, text, replyMarkup),
    (chatId) => store.deleteChat(chatId),
    {
      onFailure: () => services.failed("telegram"),
      onSuccess: () => services.succeeded("telegram"),
    },
  );
  commandController = new AbortController();
  const commands = Number(process.env.SIMULATE_RPC_OUTAGE_MS ?? 0) > 0
    ? Promise.resolve()
    : pollCommands(token, store, queue, commandController);
  try {
    await poller(store, (chatId, message, keyboard) => queue.sendMessage(chatId, message, keyboard), pollSeconds * 1000);
  } finally {
    stopping = true;
    queue.stop();
    commandController.abort();
    clearInterval(renewal);
    await commands;
    await queue.flush();
    await store.flush();
    await store.releaseLock(instanceId);
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve());
    logInfo("Watcher stopped cleanly.");
  }
}

process.on("unhandledRejection", (error: unknown) => {
  logError(`Unhandled rejection: ${errorSummary(error)}`);
  process.exitCode = 1;
  requestStop();
});
process.on("uncaughtException", (error: Error) => {
  logError(`Uncaught exception: ${errorSummary(error)}`);
  process.exitCode = 1;
  requestStop();
});

main().catch((error: unknown) => {
  logError(`Watcher stopped: ${errorSummary(error)}`);
  process.exitCode = 1;
  requestStop();
});

async function initializeStoreResiliently(store: Store, latestBlock: bigint): Promise<void> {
  const backoff = new ExponentialBackoff();
  while (!stopping) {
    try {
      await initializeStore(store, latestBlock);
      if (isRedisStoreSelected()) services.succeeded("redis");
      return;
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      services.failed("redis");
      await waitOrStop(backoff.nextDelay());
    }
  }
}

async function createStoreResiliently(): Promise<Store> {
  const backoff = new ExponentialBackoff();
  while (!stopping) {
    try {
      const store = await createStore();
      if (isRedisStoreSelected()) services.succeeded("redis");
      return store;
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      services.failed("redis");
      await waitOrStop(backoff.nextDelay());
    }
  }
  throw new Error("Shutdown requested before store initialization completed");
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|fetch|network|abort|econn|enotfound|socket/i.test(message);
}

function trackStore(store: Store): Store {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = Reflect.apply(value, target, args);
        } catch (error) {
          if (isRedisStoreSelected()) services.failed("redis");
          throw error;
        }
        if (!(result instanceof Promise)) return result;
        return result.then((resolved: unknown) => {
          if (isRedisStoreSelected()) services.succeeded("redis");
          return resolved;
        }).catch((error: unknown) => {
          if (isRedisStoreSelected()) {
            services.failed("redis");
            if (typeof error === "object" && error !== null) redisFailures.add(error);
          }
          throw error;
        });
      };
    },
  });
}

function serviceStatusLines(): string[] {
  return (Object.entries(services.snapshot()) as Array<[ServiceName, { lastSuccessAt: string | null; outage: boolean }]>)
    .map(([service, status]) =>
      `${service}: ${status.outage ? "outage" : status.lastSuccessAt ? "ok" : "unknown"}; last success ${status.lastSuccessAt ?? "never"}`,
    );
}

export { initializeStore, runDryRunDemo };
