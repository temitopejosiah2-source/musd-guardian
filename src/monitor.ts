import { getAddress, type Address, type Log } from "viem";
import { EXPLORER_URL } from "./config.js";
import { getTimeoutMs } from "./config.js";
import { getAllTransferLogs, transferDetails } from "./musd.js";
import { getLoanHealth, type LoanHealth } from "./loan.js";
import { logInfo } from "./security.js";
import type { HealthLevel, PriceSample, Store, StoredLevel } from "./store/index.js";
import { bufferPercent, ltvAtPrice, priceAtLtv } from "./risk.js";
import type { InlineKeyboardMarkup } from "./telegram.js";

export type MessageSender = (chatId: string, message: string, keyboard?: InlineKeyboardMarkup) => Promise<void>;
export interface HealthCycleResult {
  sample?: PriceSample;
  freshAddresses: Address[];
  failedChecks: number;
  totalChecks: number;
}

export function transitionLevel(
  ltv: number,
  previous: StoredLevel | undefined,
  monitorLtv: number,
  warnLtv: number,
  dangerLtv: number,
): HealthLevel {
  const prior = previous?.level ?? "SAFE";
  if (ltv >= dangerLtv) return "DANGER";
  if (prior === "DANGER" && ltv >= dangerLtv - 3) return "DANGER";
  if (ltv >= warnLtv) return "WARNING";
  if (prior === "WARNING" && ltv >= warnLtv - 3) return "WARNING";
  if (ltv >= monitorLtv) return "MONITOR";
  if (prior === "MONITOR" && ltv >= monitorLtv - 3) return "MONITOR";
  return "SAFE";
}

export async function runHealthCycle(
  store: Store,
  send: MessageSender,
  readHealth: (address: Address) => Promise<LoanHealth> = getLoanHealth,
  timeoutMs = getTimeoutMs("RPC_TIMEOUT_MS"),
): Promise<HealthCycleResult> {
  const subscriptions = await store.getAllSubscriptions();
  const unique = [...new Set(Object.values(subscriptions).flat().map(({ address }) => address))];
  let latestSample: PriceSample | undefined;
  const freshAddresses: Address[] = [];
  let next = 0;
  let failedChecks = 0;
  const workers = Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (true) {
      const index = next++;
      const address = unique.at(index);
      if (!address) return;
      try {
        const health = await timeout(readHealth(address), timeoutMs);
        freshAddresses.push(address);
        if (Number.isFinite(health.btcPriceUsd) && health.btcPriceUsd > 0) {
          latestSample ??= { t: Date.now(), price: health.btcPriceUsd };
        }
        for (const [chatId, addresses] of Object.entries(subscriptions)) {
          if (!addresses.some((item) => item.address.toLowerCase() === address.toLowerCase())) continue;
          await updateChatLevel(store, send, chatId, address, health);
        }
      } catch {
        failedChecks += 1;
        await store.recordError();
      }
    }
  });
  await Promise.all(workers);
  if (failedChecks === 0) logInfo("Health poll: OK");
  return {
    ...(latestSample ? { sample: latestSample } : {}),
    freshAddresses,
    failedChecks,
    totalChecks: unique.length,
  };
}

async function updateChatLevel(
  store: Store,
  send: MessageSender,
  chatId: string,
  address: Address,
  health: LoanHealth,
): Promise<void> {
  const previous = await store.getLevel(chatId, address);
  if (!health.troveActive) {
    if (previous?.troveActive) {
      await send(chatId, "This trove is no longer active (closed, repaid or liquidated). Check the explorer.");
    }
    await store.setLevel(chatId, address, {
      level: previous?.level ?? "SAFE",
      troveActive: false,
      ...(previous?.health ? { health: previous.health } : {}),
    });
    return;
  }

  const settings = await store.getSettings(chatId);
  const levelBasis = previous?.troveActive === false ? undefined : previous;
  const nextLevel = transitionLevel(health.ltvPercent, levelBasis, settings.monitorLtv, settings.warnLtv, settings.dangerLtv);
  const priorLevel = previous?.level ?? "SAFE";
  const now = Date.now();
  let reminderCount = levelRank(nextLevel) > levelRank(priorLevel) ? 0 : previous?.reminderCount ?? 0;
  let lastReminderAt = levelRank(nextLevel) > levelRank(priorLevel) ? now : previous?.lastReminderAt;
  if (previous && !previous.troveActive) {
    await send(
      chatId,
      `A trove is now active for ${getAddress(address)}.\n${healthLevelIcon(nextLevel)} ${nextLevel}\n${healthAlert(nextLevel, health, settings)}`,
      nextLevel === "WARNING" || nextLevel === "DANGER" ? alertKeyboard(address) : undefined,
    );
  } else if (levelRank(nextLevel) > levelRank(priorLevel)) {
    if (nextLevel === "WARNING" || nextLevel === "DANGER" || (nextLevel === "MONITOR" && settings.monitorAlerts)) {
      await send(chatId, healthAlert(nextLevel, health, settings),
        nextLevel === "WARNING" || nextLevel === "DANGER" ? alertKeyboard(address) : undefined);
    }
  } else if ((priorLevel === "WARNING" || priorLevel === "DANGER") && levelRank(nextLevel) < levelRank(priorLevel)) {
    const recoverySnoozed = previous?.snoozedUntil !== undefined && previous.snoozedUntil > now &&
      levelRank(nextLevel) <= levelRank(previous.snoozeLevel ?? "SAFE");
    if (!recoverySnoozed) {
      await send(
        chatId,
        healthAlert(nextLevel, health, settings, priorLevel),
        nextLevel === "WARNING" || nextLevel === "DANGER" ? alertKeyboard(address) : undefined,
      );
    }
  }
  const reminderMinutes = envInteger("REMIND_DANGER_MINUTES", 60);
  const reminderMax = envInteger("REMIND_MAX", 6);
  const snoozed = previous?.snoozedUntil !== undefined && previous.snoozedUntil > now &&
    levelRank(nextLevel) <= levelRank(previous.snoozeLevel ?? "SAFE");
  if (
    nextLevel === "DANGER" && priorLevel === "DANGER" && settings.reminders &&
    reminderCount < reminderMax && !snoozed &&
    (lastReminderAt === undefined || now - lastReminderAt >= reminderMinutes * 60_000)
  ) {
    await send(chatId, healthAlert("DANGER", health, settings), alertKeyboard(address));
    reminderCount += 1;
    lastReminderAt = now;
  }
  await store.setLevel(chatId, address, {
    level: nextLevel,
    troveActive: true,
    health,
    reminderCount,
    ...(lastReminderAt !== undefined ? { lastReminderAt } : {}),
    ...(previous?.snoozedUntil !== undefined ? { snoozedUntil: previous.snoozedUntil } : {}),
    ...(previous?.snoozeLevel !== undefined ? { snoozeLevel: previous.snoozeLevel } : {}),
  });
}

export function healthAlert(level: HealthLevel, health: LoanHealth, settings: {
  monitorLtv: number; warnLtv: number; dangerLtv: number;
}, recoveryFrom?: HealthLevel): string {
  let heading: string;
  if (recoveryFrom) {
    heading = level === "SAFE"
      ? "RECOVERY: Loan health is back below MONITOR."
      : `RECOVERY: Loan health improved from ${recoveryFrom} to ${level}.`;
  } else if (level === "DANGER") {
    heading = "DANGER: loan health is at high risk";
  } else if (level === "WARNING") {
    heading = "WARNING: loan health needs attention";
  } else if (level === "MONITOR") {
    heading = "MONITOR: loan health entered the monitor zone";
  } else {
    heading = "SAFE: loan health is below MONITOR.";
  }
  return [
    heading,
    `LTV: ${health.ltvPercent.toFixed(2)}%`,
    `Collateral: ${health.collateralBtc} BTC`,
    `Debt: ${health.debtMusd} MUSD`,
    `BTC price: $${health.btcPriceUsd}`,
    ...healthBufferLines(health, settings),
    `Distance to liquidation: ${health.distanceToLiquidationPercent.toFixed(2)} percentage points`,
    level === "SAFE"
      ? "Tip: keep a buffer by adding collateral or repaying MUSD if market conditions change."
      : "Tip: add collateral or repay MUSD to lower your LTV.",
    EXPLORER_URL,
  ].join("\n");
}

export function healthBufferLines(
  health: LoanHealth,
  settings: { warnLtv: number; dangerLtv: number },
): string[] {
  const liquidationPrice = priceAtLtv(health.debtMusd, health.collateralBtc, 90);
  const warnPrice = priceAtLtv(health.debtMusd, health.collateralBtc, settings.warnLtv);
  const dangerPrice = priceAtLtv(health.debtMusd, health.collateralBtc, settings.dangerLtv);
  const warnBuffer = warnPrice === null ? null : bufferPercent(health.btcPriceUsd, warnPrice);
  const dangerBuffer = dangerPrice === null ? null : bufferPercent(health.btcPriceUsd, dangerPrice);
  const liquidationBuffer = liquidationPrice === null ? null : bufferPercent(health.btcPriceUsd, liquidationPrice);
  return [
    `Liquidation price (90% LTV): ${formatUsd(liquidationPrice)}`,
    `BTC price at WARNING (${settings.warnLtv}%): ${formatUsd(warnPrice)}`,
    `BTC price at DANGER (${settings.dangerLtv}%): ${formatUsd(dangerPrice)}`,
    `BTC can fall ${formatBuffer(warnBuffer, "WARNING")}, ${formatBuffer(dangerBuffer, "DANGER")}, ${formatBuffer(liquidationBuffer, "liquidation")}.`,
  ];
}

export async function processTransferRange(
  store: Store,
  send: MessageSender,
  fromBlock: bigint,
  toBlock: bigint,
  logsReader: (from: bigint, to: bigint) => Promise<Log[]> = getAllTransferLogs,
  decimals = 18,
): Promise<void> {
  const subscriptions = await store.getAllSubscriptions();
  const tracked = new Map<string, { chats: string[]; address: Address }>();
  const chatSettings = new Map<string, boolean>();
  for (const [chatId, entries] of Object.entries(subscriptions)) {
    const settings = await store.getSettings(chatId);
    chatSettings.set(chatId, settings.transfers);
    for (const item of entries) {
      const key = item.address.toLowerCase();
      const existing = tracked.get(key);
      if (existing) existing.chats.push(chatId);
      else tracked.set(key, { chats: [chatId], address: item.address });
    }
  }
  const logs = await logsReader(fromBlock, toBlock);
  for (const log of logs) {
    if (!log.transactionHash || log.logIndex === null) {
      throw new Error("Received a MUSD Transfer log without a transaction hash or log index");
    }
    const detailsAddress = [log.topics[1], log.topics[2]]
      .filter((topic): topic is `0x${string}` => topic !== null && topic !== undefined)
      .map((topic) => `0x${topic.slice(-40).toLowerCase()}`);
    const relevant = new Set(detailsAddress);
    for (const key of relevant) {
      const recipient = tracked.get(key);
      if (!recipient) continue;
      const details = transferDetails(log, recipient.address, decimals);
      const message = [
        `${details.direction} ${details.amount} MUSD`,
        `Address: ${shortAddress(recipient.address)}`,
        `Counterparty: ${shortAddress(details.counterparty)}`,
        `${EXPLORER_URL}/tx/${log.transactionHash}`,
      ].join("\n");
      for (const chatId of recipient.chats) {
        if (!chatSettings.get(chatId)) continue;
        const keyForChat = `${log.transactionHash}:${log.logIndex}:${chatId}`;
        if (!(await store.markSent(keyForChat))) continue;
        try {
          await send(chatId, message);
        } catch (error) {
          await store.unmarkSent(keyForChat);
          throw error;
        }
      }
    }
  }
  await store.setLastProcessedBlock(toBlock);
  logInfo(`Processed blocks ${fromBlock}-${toBlock}`);
}

function shortAddress(address: Address): string {
  const normalized = getAddress(address);
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function levelRank(level: StoredLevel["level"]): number {
  return level === "DANGER" ? 3 : level === "WARNING" ? 2 : level === "MONITOR" ? 1 : 0;
}

function formatUsd(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(1)}`;
}

function formatBuffer(value: number | null, level: string): string {
  if (value === null) return `unavailable before ${level}`;
  if (value < 0) return `already past ${level} by ${Math.abs(value).toFixed(1)}%`;
  return `${value.toFixed(1)}% before ${level}`;
}

function healthLevelIcon(level: HealthLevel): string {
  return level === "DANGER" ? "🔴" : level === "WARNING" ? "🟠" : level === "MONITOR" ? "🟡" : "🟢";
}

export function alertKeyboard(address: Address): InlineKeyboardMarkup {
  const raw = address.slice(2).toLowerCase();
  return {
    inline_keyboard: [
      [
        { text: "Check now", callback_data: `c:${raw}` },
        { text: "Snooze 1h", callback_data: `s1:${raw}` },
        { text: "Snooze 6h", callback_data: `s6:${raw}` },
      ],
      [
        { text: "Open Mezo Borrow", url: "https://testnet.mezo.org/borrow" },
        { text: "Explorer", url: `https://explorer.test.mezo.org/address/${getAddress(address)}` },
      ],
    ],
  };
}

export function detectPriceDrop(
  samples: PriceSample[],
  now: number,
  windowMs = 60 * 60_000,
): { previous: PriceSample; current: PriceSample; percent: number } | undefined {
  const recent = samples.filter((sample) =>
    Number.isFinite(sample.t) && Number.isFinite(sample.price) && sample.price > 0 &&
    sample.t >= now - windowMs && sample.t <= now,
  );
  const current = recent.at(-1);
  if (!current) return undefined;
  const previous = recent.slice(0, -1).reduce<PriceSample | undefined>(
    (highest, sample) => !highest || sample.price > highest.price ? sample : highest,
    undefined,
  );
  if (!previous) return undefined;
  const percent = (previous.price - current.price) / previous.price * 100;
  return percent > 0 ? { previous, current, percent } : undefined;
}

export async function processPriceDropAlerts(
  store: Store,
  send: MessageSender,
  freshAddresses: Address[],
  now = Date.now(),
): Promise<void> {
  const samples = await store.getPriceSamples();
  const newest = samples.at(-1);
  const maximumAgeMs = envInteger("PRICE_MAX_AGE_SECONDS", 600) * 1000;
  if (!newest || now - newest.t > maximumAgeMs || newest.t > now) return;
  const drop = detectPriceDrop(samples, now);
  if (!drop) return;

  const fresh = new Set(freshAddresses.map((address) => address.toLowerCase()));
  const subscriptions = await store.getAllSubscriptions();
  const cooldownMs = envInteger("PRICE_ALERT_COOLDOWN_MINUTES", 360) * 60_000;
  for (const [chatId, entries] of Object.entries(subscriptions)) {
    const settings = await store.getSettings(chatId);
    if (!settings.priceAlerts || drop.percent < settings.dropPercent) continue;
    const previousAlert = await store.getPriceAlertAt(chatId);
    if (previousAlert !== undefined && now - previousAlert < cooldownMs) continue;
    const active: Array<{ address: Address; health: LoanHealth; level: HealthLevel }> = [];
    for (const { address } of entries) {
      if (!fresh.has(address.toLowerCase())) continue;
      const state = await store.getLevel(chatId, address);
      if (!state?.troveActive || !state.health?.troveActive) continue;
      const level = state.level;
      if (
        state.snoozedUntil !== undefined && state.snoozedUntil > now &&
        levelRank(level) <= levelRank(state.snoozeLevel ?? "SAFE")
      ) continue;
      active.push({ address, health: state.health, level });
    }
    if (active.length === 0) continue;
    const visible = active.slice(0, 5);
    const lines = [
      `BTC price drop: $${drop.previous.price.toFixed(1)} to $${drop.current.price.toFixed(1)} (${drop.percent.toFixed(1)}%).`,
      ...visible.flatMap(({ address, health, level }) => {
        const before = ltvAtPrice(health.debtMusd, health.collateralBtc, drop.previous.price);
        const after = ltvAtPrice(health.debtMusd, health.collateralBtc, drop.current.price);
        return [
          `${getAddress(address)} — ${level}`,
          `LTV before ${before === null ? "unavailable" : `${before.toFixed(1)}%`}; after ${after === null ? "unavailable" : `${after.toFixed(1)}%`}.`,
          ...healthBufferLines({ ...health, btcPriceUsd: drop.current.price }, settings),
        ];
      }),
    ];
    if (active.length > visible.length) lines.push(`and ${active.length - visible.length} more`);
    await store.setPriceAlertAt(chatId, now);
    await send(chatId, lines.join("\n"), alertKeyboard(visible[0]!.address));
  }
}

function envInteger(
  name: "REMIND_DANGER_MINUTES" | "REMIND_MAX" | "PRICE_MAX_AGE_SECONDS" | "PRICE_ALERT_COOLDOWN_MINUTES",
  fallback: number,
): number {
  const raw = name === "REMIND_DANGER_MINUTES"
    ? process.env.REMIND_DANGER_MINUTES
    : name === "REMIND_MAX"
      ? process.env.REMIND_MAX
      : name === "PRICE_MAX_AGE_SECONDS"
        ? process.env.PRICE_MAX_AGE_SECONDS
        : process.env.PRICE_ALERT_COOLDOWN_MINUTES;
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Address health check timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
