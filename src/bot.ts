import { formatUnits, getAddress, type Address } from "viem";
import { EXPLORER_URL } from "./config.js";
import { getMusdBalance, getMusdDecimals } from "./musd.js";
import { publicClient } from "./client.js";
import { getLoanHealth, type LoanHealth } from "./loan.js";
import { logError, registerChatId } from "./security.js";
import { CommandRateLimiter } from "./rate-limit.js";
import type { Store, StoreLimits } from "./store/index.js";
import { normalizeAddress, validateLabel } from "./store/validation.js";
import { TelegramApiError, type TelegramUpdate } from "./telegram.js";
import { bufferPercent, ltvAtPrice, priceAtLtv } from "./risk.js";
import type { HealthLevel } from "./store/types.js";

export const limitsFromEnvironment = (): StoreLimits => ({
  maxAddressesPerChat: readLimit("MAX_ADDRESSES_PER_CHAT", process.env.MAX_ADDRESSES_PER_CHAT, 5),
  maxChats: readLimit("MAX_CHATS", process.env.MAX_CHATS, 150),
  maxTotalAddresses: readLimit("MAX_TOTAL_ADDRESSES", process.env.MAX_TOTAL_ADDRESSES, 300),
});

export type BotDependencies = {
  store: Store;
  send: (chatId: string, text: string) => Promise<void>;
  getHealth?: (address: Address) => Promise<LoanHealth>;
  getBalance?: (address: Address) => Promise<{ native: bigint; musd: bigint; decimals: number }>;
  getAdminStatus?: () => Promise<string[]>;
  getPriceStatus?: () => Promise<string>;
  answerCallback?: (callbackId: string, text?: string) => Promise<void>;
  adminChatId?: string;
};

export class BotCommands {
  private readonly rateLimiter = new CommandRateLimiter();
  private readonly stopConfirmations = new Map<string, number>();
  private readonly unknownAt = new Map<string, number>();

  constructor(private readonly dependencies: BotDependencies) {}

  async handle(update: TelegramUpdate): Promise<void> {
    if (update.callbackQueryId !== undefined) {
      await this.handleCallback(update);
      return;
    }
    if (
      update.chatType !== "private" || update.senderIsBot !== false ||
      update.chatId === undefined || update.senderId === undefined ||
      typeof update.text !== "string" || update.text.length > 500
    ) return;
    const chatId = String(update.chatId);
    registerChatId(chatId);
    const text = update.text.trim();
    const words = text.split(/\s+/);
    const commandToken = words.shift() ?? "";
    if (!commandToken.startsWith("/")) return;
    const command = `/${(commandToken.slice(1).split("@")[0] ?? "").toLowerCase()}`;
    const args = words.join(" ").trim();
    const knownCommands = new Set([
      "/start", "/help", "/watch", "/unwatch", "/list", "/health", "/balance",
      "/whatif", "/settings", "/setwarn", "/setdanger", "/transfers", "/stop", "/admin",
      "/setmonitor", "/monitoralerts", "/pricealerts", "/setdrop", "/reminders", "/unsnooze", "/status",
    ]);
    if (!knownCommands.has(command)) {
      if (Date.now() - (this.unknownAt.get(chatId) ?? 0) >= 60_000) {
        this.unknownAt.set(chatId, Date.now());
        await this.dependencies.send(chatId, "Unknown command. Try /help.");
      }
      return;
    }
    if (!this.rateLimiter.allow(chatId, command)) {
      await this.dependencies.send(chatId, "Command limit reached. Please try again later.");
      return;
    }
    try {
      const reply = await this.execute(chatId, command, args);
      if (reply) await this.dependencies.send(chatId, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      if (error instanceof TelegramApiError) throw error;
      await this.dependencies.store.recordError();
      logError(`Command ${command} failed: ${message}`);
      await this.dependencies.send(chatId, friendlyError(message));
    }
  }

  private async handleCallback(update: TelegramUpdate): Promise<void> {
    const callbackId = update.callbackQueryId;
    if (!callbackId) return;
    let answer = "Invalid button.";
    try {
      if (
        update.callbackChatType !== "private" || update.callbackChatId === undefined ||
        update.callbackSenderId === undefined || update.callbackSenderIsBot !== false
      ) return;
      const chatId = String(update.callbackChatId);
      registerChatId(chatId);
      if (!this.rateLimiter.allow(chatId, "callback")) {
        answer = "Please wait before using another button.";
        return;
      }
      const match = /^(c|s1|s6):([0-9a-f]{40})$/i.exec(update.callbackData ?? "");
      if (!match) return;
      let address: Address;
      try {
        address = normalizeAddress(`0x${match[2]}`);
      } catch {
        return;
      }
      const subscriptions = await this.dependencies.store.getSubscriptions(chatId);
      if (!subscriptions.some((item) => item.address.toLowerCase() === address.toLowerCase())) {
        answer = "That address is no longer on your watch list.";
        return;
      }
      if (match[1] !== "c") {
        const current = await this.dependencies.store.getLevel(chatId, address);
        const snoozeLevel = current?.level ?? "SAFE";
        const duration = match[1] === "s1" ? 60 * 60_000 : 6 * 60 * 60_000;
        const until = current?.snoozedUntil && current.snoozedUntil > Date.now()
          ? current.snoozedUntil
          : Date.now() + duration;
        await this.dependencies.store.setLevel(chatId, address, {
          ...(current ?? { level: snoozeLevel, troveActive: false }),
          snoozedUntil: until,
          snoozeLevel,
        });
        answer = `Snoozed until ${new Date(until).toISOString()}.`;
        return;
      }
      const health = await this.getHealth(address);
      const settings = await this.dependencies.store.getSettings(chatId);
      const current = await this.dependencies.store.getLevel(chatId, address);
      await this.dependencies.send(chatId, formatHealth(health, settings, current?.snoozedUntil));
      answer = "Health update sent.";
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      await this.dependencies.store.recordError();
      logError("Telegram button action failed.");
      answer = "Could not complete that action.";
    } finally {
      await this.dependencies.answerCallback?.(callbackId, answer);
    }
  }

  private async execute(chatId: string, command: string, args: string): Promise<string | undefined> {
    if (command === "/start") return this.start(chatId, args);
    if (command === "/help") return helpText;
    if (command === "/watch") return this.watch(chatId, args);
    if (command === "/unwatch") return this.unwatch(chatId, args);
    if (command === "/list") return this.list(chatId);
    if (command === "/health") return this.health(chatId, args);
    if (command === "/balance") return this.balance(chatId, args);
    if (command === "/whatif") return this.whatIf(chatId, args);
    if (command === "/settings") return this.settings(chatId);
    if (command === "/setwarn") return this.setThreshold(chatId, args, "warnLtv");
    if (command === "/setdanger") return this.setThreshold(chatId, args, "dangerLtv");
    if (command === "/setmonitor") return this.setThreshold(chatId, args, "monitorLtv");
    if (command === "/transfers") return this.transfers(chatId, args);
    if (command === "/monitoralerts") return this.toggleSetting(chatId, args, "monitorAlerts", "Monitor alerts");
    if (command === "/pricealerts") return this.toggleSetting(chatId, args, "priceAlerts", "Price alerts");
    if (command === "/reminders") return this.toggleSetting(chatId, args, "reminders", "DANGER reminders");
    if (command === "/setdrop") return this.setDrop(chatId, args);
    if (command === "/unsnooze") return this.unsnooze(chatId);
    if (command === "/status") return (await this.dependencies.getPriceStatus?.()) ?? "Oracle price status is unavailable.";
    if (command === "/stop") return this.stop(chatId, args);
    if (command === "/admin") return this.admin(chatId);
    return undefined;
  }

  private async start(chatId: string, args: string): Promise<string> {
    if (args) {
      const deepLink = /^w_([0-9a-f]{40})$/i.exec(args);
      if (!deepLink) return "Invalid start link.";
      const address = normalizeAddress(`0x${deepLink[1]}`);
      return this.watch(chatId, address);
    }
    return [
      "Monitors Mezo trove health and MUSD transfers for addresses you choose.",
      "Stores your chat id, watched addresses, alert thresholds, and settings.",
      "Use /watch <address> [label] to subscribe; /help lists commands.",
      "Use /stop, then /stop confirm to delete your data.",
    ].join("\n");
  }

  private async watch(chatId: string, args: string): Promise<string> {
    const [addressText, ...labelParts] = args.split(/\s+/).filter(Boolean);
    if (!addressText) return "Usage: /watch <address> [label]";
    const address = normalizeAddress(addressText);
    const label = validateLabel(labelParts.length ? labelParts.join(" ") : undefined);
    try {
      await this.dependencies.store.addSubscription(
        chatId,
        { address: address.toLowerCase() as Address, ...(label ? { label } : {}) },
        limitsFromEnvironment(),
      );
    } catch (error) {
      if (error instanceof Error && /limit reached/.test(error.message)) {
        return `${error.message}. Remove a watched address or try again later.`;
      }
      throw error;
    }
    let health: LoanHealth;
    try {
      health = await this.getHealth(address);
    } catch {
      await this.dependencies.store.recordError();
      return `${formatAddress(address)} is now watched. Health data is temporarily unavailable; monitoring will retry.`;
    }
    const settings = await this.dependencies.store.getSettings(chatId);
    const level = health.troveActive ? healthLevel(health.ltvPercent, settings) : "SAFE";
    await this.dependencies.store.setLevel(chatId, address, {
      level,
      troveActive: health.troveActive,
      health,
      reminderCount: 0,
    });
    if (!health.troveActive) {
      return `${formatAddress(address)} is now watched. No active trove was found; I'll alert you if one appears.\n${formatHealth(health, settings)}`;
    }
    return `${formatAddress(address)} is now watched.\n${formatHealth(health, settings)}`;
  }

  private async unwatch(chatId: string, args: string): Promise<string> {
    if (!args || args.split(/\s+/).length !== 1) return "Usage: /unwatch <address>";
    const address = normalizeAddress(args);
    const removed = await this.dependencies.store.removeSubscription(chatId, address);
    return removed ? `Stopped watching ${formatAddress(address)}.` : "That address is not on your watch list.";
  }

  private async list(chatId: string): Promise<string> {
    const subscriptions = await this.dependencies.store.getSubscriptions(chatId);
    if (subscriptions.length === 0) return "No watched addresses. Use /watch <address> [label].";
    const lines = await Promise.all(subscriptions.map(async ({ address, label }) => {
      const state = await this.dependencies.store.getLevel(chatId, address);
      const level = state ? (state.troveActive ? state.level : "NO_LOAN") : "UNKNOWN";
      const icon = level === "NO_LOAN" || level === "UNKNOWN" ? "⚪" : levelIcon(level);
      const snooze = state?.snoozedUntil && state.snoozedUntil > Date.now()
        ? ` (snoozed until ${new Date(state.snoozedUntil).toISOString()})`
        : "";
      return `${label ? `${label}: ` : ""}${formatAddress(address)} — ${icon} ${level}${snooze}`;
    }));
    return lines.join("\n");
  }

  private async health(chatId: string, args: string): Promise<string> {
    const address = await this.resolveAddress(chatId, args);
    const [health, settings] = await Promise.all([
      this.getHealth(address),
      this.dependencies.store.getSettings(chatId),
    ]);
    const level = await this.dependencies.store.getLevel(chatId, address);
    return formatHealth(health, settings, level?.snoozedUntil);
  }

  private async balance(chatId: string, args: string): Promise<string> {
    const address = await this.resolveAddress(chatId, args);
    const getBalance = this.dependencies.getBalance ?? (async (account) => {
      const [native, musd, decimals] = await Promise.all([
        publicClient.getBalance({ address: account }), getMusdBalance(account), getMusdDecimals(),
      ]);
      return { native, musd, decimals };
    });
    const balance = await getBalance(address);
    return `BTC balance: ${formatUnits(balance.native, 18)} BTC\nMUSD balance: ${formatUnits(balance.musd, balance.decimals)} MUSD`;
  }

  private async whatIf(chatId: string, args: string): Promise<string> {
    const [priceText, addressText, ...extra] = args.split(/\s+/);
    const price = Number(priceText);
    if (!priceText || !Number.isFinite(price) || price <= 0 || extra.length > 0) {
      return "Usage: /whatif <btc price in USD> [address]";
    }
    const address = await this.resolveAddress(chatId, addressText ?? "");
    const health = await this.getHealth(address);
    if (!health.troveActive) return `No active trove for ${formatAddress(address)}.`;
    const ltv = ltvAtPrice(health.debtMusd, health.collateralBtc, price);
    return `At BTC price $${price.toFixed(2)}:\nLTV: ${ltv === null ? "unavailable" : `${ltv.toFixed(2)}%`}\nDistance to liquidation: ${ltv === null ? "unavailable" : `${(90 - ltv).toFixed(2)} percentage points`}`;
  }

  private async settings(chatId: string): Promise<string> {
    const value = await this.dependencies.store.getSettings(chatId);
    return [
      `Monitor LTV: ${value.monitorLtv}%`,
      `Warn LTV: ${value.warnLtv}%`,
      `Danger LTV: ${value.dangerLtv}%`,
      `Monitor alerts: ${value.monitorAlerts ? "on" : "off"}`,
      `Price alerts: ${value.priceAlerts ? "on" : "off"}`,
      `Price drop: ${value.dropPercent}%`,
      `DANGER reminders: ${value.reminders ? "on" : "off"}`,
      `Transfers: ${value.transfers ? "on" : "off"}`,
    ].join("\n");
  }

  private async setThreshold(chatId: string, args: string, key: "monitorLtv" | "warnLtv" | "dangerLtv"): Promise<string> {
    const command = key === "monitorLtv" ? "/setmonitor" : key === "warnLtv" ? "/setwarn" : "/setdanger";
    if (!/^\d{1,2}$/.test(args)) return `Usage: ${command} <1-${key === "monitorLtv" ? "88" : "89"}>`;
    const value = Number(args);
    if (value < 1 || value > (key === "monitorLtv" ? 88 : 89)) return `Threshold must be an integer from 1 to ${key === "monitorLtv" ? "88" : "89"}.`;
    const settings = await this.dependencies.store.getSettings(chatId);
    const next = { ...settings, [key]: value };
    if (!(next.monitorLtv < next.warnLtv && next.warnLtv < next.dangerLtv && next.dangerLtv < 90)) {
      return "Thresholds must remain ordered: monitor < warn < danger < 90.";
    }
    await this.dependencies.store.setSettings(chatId, next);
    return `${key === "monitorLtv" ? "Monitor" : key === "warnLtv" ? "Warn" : "Danger"} threshold set to ${value}%.`;
  }

  private async toggleSetting(
    chatId: string,
    args: string,
    key: "monitorAlerts" | "priceAlerts" | "reminders",
    label: string,
  ): Promise<string> {
    const command = key === "monitorAlerts" ? "monitoralerts" : key === "priceAlerts" ? "pricealerts" : "reminders";
    if (args !== "on" && args !== "off") return `Usage: /${command} on|off`;
    const settings = await this.dependencies.store.getSettings(chatId);
    await this.dependencies.store.setSettings(chatId, { ...settings, [key]: args === "on" });
    return `${label} turned ${args}.`;
  }

  private async setDrop(chatId: string, args: string): Promise<string> {
    if (!/^\d{1,2}$/.test(args) || Number(args) < 1 || Number(args) > 50) {
      return "Usage: /setdrop <1-50>";
    }
    const settings = await this.dependencies.store.getSettings(chatId);
    await this.dependencies.store.setSettings(chatId, { ...settings, dropPercent: Number(args) });
    return `Price-drop threshold set to ${Number(args)}%.`;
  }

  private async unsnooze(chatId: string): Promise<string> {
    const subscriptions = await this.dependencies.store.getSubscriptions(chatId);
    let cleared = 0;
    for (const { address } of subscriptions) {
      const current = await this.dependencies.store.getLevel(chatId, address);
      if (!current?.snoozedUntil) continue;
      const rest = { ...current };
      delete rest.snoozedUntil;
      delete rest.snoozeLevel;
      await this.dependencies.store.setLevel(chatId, address, rest);
      cleared += 1;
    }
    return cleared > 0 ? "Snoozes cleared." : "No active snoozes.";
  }

  private async transfers(chatId: string, args: string): Promise<string> {
    if (args !== "on" && args !== "off") return "Usage: /transfers on|off";
    const settings = await this.dependencies.store.getSettings(chatId);
    await this.dependencies.store.setSettings(chatId, { ...settings, transfers: args === "on" });
    return `Transfer alerts turned ${args}.`;
  }

  private async stop(chatId: string, args: string): Promise<string> {
    if (args.toLowerCase() !== "confirm") {
      this.stopConfirmations.set(chatId, Date.now() + 60_000);
      return "This deletes your watched addresses, settings, and levels. Confirm with /stop confirm within 60 seconds.";
    }
    if ((this.stopConfirmations.get(chatId) ?? 0) < Date.now()) return "No active confirmation. Start again with /stop.";
    this.stopConfirmations.delete(chatId);
    await this.dependencies.store.deleteChat(chatId);
    return "Your stored chat data has been deleted.";
  }

  private async admin(chatId: string): Promise<string> {
    if (!this.dependencies.adminChatId || chatId !== this.dependencies.adminChatId) return "This command is not available.";
    const lines = await this.dependencies.getAdminStatus?.();
    return lines?.join("\n") ?? "Admin status is unavailable.";
  }

  private async resolveAddress(chatId: string, requested: string): Promise<Address> {
    if (requested) return normalizeAddress(requested);
    const subscriptions = await this.dependencies.store.getSubscriptions(chatId);
    const first = subscriptions[0]?.address;
    if (!first) throw new Error("No watched address. Use /watch <address> first.");
    return first;
  }

  private async getHealth(address: Address): Promise<LoanHealth> {
    return (this.dependencies.getHealth ?? getLoanHealth)(address);
  }
}

export function healthText(health: LoanHealth, settings = {
  monitorLtv: Number(process.env.MONITOR_LTV ?? 55),
  warnLtv: Number(process.env.WARN_LTV ?? 70),
  dangerLtv: Number(process.env.DANGER_LTV ?? 80),
}): string {
  const liquidation = health.troveActive ? priceAtLtv(health.debtMusd, health.collateralBtc, 90) : null;
  const warn = health.troveActive ? priceAtLtv(health.debtMusd, health.collateralBtc, settings.warnLtv) : null;
  const danger = health.troveActive ? priceAtLtv(health.debtMusd, health.collateralBtc, settings.dangerLtv) : null;
  return [
    `Trove active: ${health.troveActive ? "yes" : "no"}`,
    ...(!health.troveActive ? ["No active loan was found for this address."] : []),
    `LTV: ${health.ltvPercent.toFixed(2)}%`,
    `Collateral: ${health.collateralBtc} BTC`,
    `Debt: ${health.debtMusd} MUSD`,
    `BTC price: $${health.btcPriceUsd}`,
    `Distance to liquidation: ${health.distanceToLiquidationPercent.toFixed(2)} percentage points`,
    `Liquidation price (90% LTV): ${formatUsd(liquidation)}`,
    `BTC price at WARNING (${settings.warnLtv}%): ${formatUsd(warn)}`,
    `BTC price at DANGER (${settings.dangerLtv}%): ${formatUsd(danger)}`,
    `BTC can fall ${formatBuffer(warn === null ? null : bufferPercent(health.btcPriceUsd, warn), "WARNING")}, ${formatBuffer(danger === null ? null : bufferPercent(health.btcPriceUsd, danger), "DANGER")}, ${formatBuffer(liquidation === null ? null : bufferPercent(health.btcPriceUsd, liquidation), "liquidation")}.`,
    `${EXPLORER_URL}`,
  ].join("\n");
}

export function formatHealth(health: LoanHealth, settings: {
  monitorLtv: number; warnLtv: number; dangerLtv: number;
}, snoozedUntil?: number): string {
  if (!health.troveActive) {
    const snooze = snoozedUntil && snoozedUntil > Date.now()
      ? `\nSnoozed until ${new Date(snoozedUntil).toISOString()}`
      : "";
    return `Level: ⚪ NO_LOAN\n${healthText(health, settings)}${snooze}`;
  }
  const level = healthLevel(health.ltvPercent, settings);
  const snooze = snoozedUntil && snoozedUntil > Date.now()
    ? `\nSnoozed until ${new Date(snoozedUntil).toISOString()}`
    : "";
  return `Level: ${levelIcon(level)} ${level}\n${healthText(health, settings)}${snooze}`;
}

export function healthLevel(ltv: number, thresholds: { monitorLtv: number; warnLtv: number; dangerLtv: number }): HealthLevel {
  if (ltv >= thresholds.dangerLtv) return "DANGER";
  if (ltv >= thresholds.warnLtv) return "WARNING";
  if (ltv >= thresholds.monitorLtv) return "MONITOR";
  return "SAFE";
}

export function levelIcon(level: HealthLevel): string {
  return level === "DANGER" ? "🔴" : level === "WARNING" ? "🟠" : level === "MONITOR" ? "🟡" : "🟢";
}

function formatUsd(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(1)}`;
}

function formatBuffer(value: number | null, label: string): string {
  if (value === null) return `unavailable before ${label}`;
  if (value < 0) return `already past ${label} by ${Math.abs(value).toFixed(1)}%`;
  return `${value.toFixed(1)}% before ${label}`;
}

const helpText = [
  "Commands:",
  "/watch <address> [label] - subscribe",
  "/unwatch <address> - remove an address",
  "/list - list watched addresses",
  "/health [address] - loan health",
  "/balance [address] - BTC and MUSD balances",
  "/whatif <btc price in USD> [address] - estimated LTV",
  "/settings, /setmonitor <n>, /setwarn <n>, /setdanger <n>",
  "/monitoralerts on|off, /pricealerts on|off, /setdrop <n>, /reminders on|off",
  "/transfers on|off, /unsnooze, /status",
  "/status - oracle price freshness",
  "/stop - delete stored data after confirmation",
].join("\n");

function formatAddress(address: Address): string {
  return getAddress(address);
}

function friendlyError(message: string): string {
  if (/limit reached/.test(message)) return `${message}. Remove an address or try later.`;
  if (/address|zero address/i.test(message)) return "Address is invalid. Check it and try again.";
  if (/label/i.test(message)) return "Label must contain only letters, numbers, spaces, dashes, or underscores (max 24 characters).";
  if (/threshold|warn and danger/i.test(message)) return "Invalid threshold. Keep monitor < warn < danger < 90.";
  return "Could not complete that command. Please try again later.";
}

function readLimit(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
