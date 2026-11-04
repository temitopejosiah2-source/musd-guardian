import type { Address } from "viem";
import { defaultSettings, validateSettings, validateSubscription } from "./validation.js";
import { validateChatId, normalizeAddress } from "./validation.js";
import type {
  ChatSettings,
  LockRenewalResult,
  Store,
  StoreLimits,
  StoreMetrics,
  StoredLevel,
  Subscription,
} from "./types.js";
import type { StoreSnapshot } from "./types.js";
import { emptySnapshot } from "./validation.js";

/* eslint security/detect-object-injection: "off" -- Chat ids and addresses are validated before persisted-record indexing. */
let inProcessLock: { instanceId: string; expiresAt: number } | undefined;

export class MemoryStore implements Store {
  protected data: StoreSnapshot = emptySnapshot();
  protected reverse = new Map<string, Set<string>>();
  protected lockId: string | undefined;
  protected lockUntil = 0;
  protected redisCommands = 0;

  async listChats(): Promise<string[]> {
    return Object.keys(this.data.subscriptions);
  }

  async getSubscriptions(chatId: string): Promise<Subscription[]> {
    validateChatId(chatId);
    return Object.values(this.data.subscriptions[chatId] ?? {});
  }

  async getSubscriptionsForAddress(address: Address): Promise<string[]> {
    const key = normalizeAddress(address).toLowerCase();
    return [...(this.reverse.get(key) ?? [])];
  }

  async getAllSubscriptions(): Promise<Record<string, Subscription[]>> {
    return Object.fromEntries(
      Object.entries(this.data.subscriptions).map(([chatId, values]) => [
        chatId,
        Object.values(values),
      ]),
    );
  }

  async addSubscription(chatId: string, item: Subscription, limits: StoreLimits): Promise<void> {
    validateChatId(chatId);
    if (
      !Number.isInteger(limits.maxAddressesPerChat) || limits.maxAddressesPerChat < 1 ||
      !Number.isInteger(limits.maxChats) || limits.maxChats < 1 ||
      !Number.isInteger(limits.maxTotalAddresses) || limits.maxTotalAddresses < 1
    ) throw new Error("Store limits must be positive integers");
    const subscription = validateSubscription(item);
    const chats = Object.keys(this.data.subscriptions);
    const entries = this.data.subscriptions[chatId] ?? {};
    if (Object.hasOwn(entries, subscription.address)) {
      entries[subscription.address] = subscription;
      this.data.subscriptions[chatId] = entries;
      return;
    }
    if (Object.keys(entries).length >= limits.maxAddressesPerChat) throw new Error("Address limit reached");
    if (!chats.includes(chatId) && chats.length >= limits.maxChats) throw new Error("Chat limit reached");
    const addresses = new Set(Object.values(this.data.subscriptions).flatMap(Object.keys));
    if (!addresses.has(subscription.address) && addresses.size >= limits.maxTotalAddresses) {
      throw new Error("Total address limit reached");
    }
    this.data.subscriptions[chatId] = { ...entries, [subscription.address]: subscription };
    const chatsForAddress = this.reverse.get(subscription.address) ?? new Set<string>();
    chatsForAddress.add(chatId);
    this.reverse.set(subscription.address, chatsForAddress);
    if (!this.data.settings[chatId]) this.data.settings[chatId] = defaultSettings();
  }

  async removeSubscription(chatId: string, address: Address): Promise<boolean> {
    validateChatId(chatId);
    const key = normalizeAddress(address).toLowerCase();
    const entries = this.data.subscriptions[chatId];
    if (!entries || !Object.hasOwn(entries, key)) return false;
    delete entries[key];
    delete this.data.levels[chatId]?.[key];
    this.removeReverseChat(key, chatId);
    if (Object.keys(entries).length === 0) {
      delete this.data.subscriptions[chatId];
      delete this.data.settings[chatId];
      delete this.data.levels[chatId];
      delete this.data.priceAlertAt[chatId];
    }
    return true;
  }

  async deleteChat(chatId: string): Promise<void> {
    validateChatId(chatId);
    for (const address of Object.keys(this.data.subscriptions[chatId] ?? {})) {
      this.removeReverseChat(address, chatId);
    }
    delete this.data.subscriptions[chatId];
    delete this.data.settings[chatId];
    delete this.data.levels[chatId];
    for (const key of Object.keys(this.data.sentKeys)) {
      if (key.endsWith(`:${chatId}`)) delete this.data.sentKeys[key];
    }
  }

  async getSettings(chatId: string): Promise<ChatSettings> {
    validateChatId(chatId);
    return this.data.settings[chatId] ?? defaultSettings();
  }

  async setSettings(chatId: string, settings: ChatSettings): Promise<void> {
    validateChatId(chatId);
    this.data.settings[chatId] = validateSettings(settings);
  }

  async getLevel(chatId: string, address: Address): Promise<StoredLevel | undefined> {
    validateChatId(chatId);
    return this.data.levels[chatId]?.[normalizeAddress(address).toLowerCase()];
  }

  async setLevel(chatId: string, address: Address, level: StoredLevel): Promise<void> {
    validateChatId(chatId);
    const key = normalizeAddress(address).toLowerCase();
    this.data.levels[chatId] ??= {};
    this.data.levels[chatId][key] = level;
  }

  async getLastProcessedBlock(): Promise<bigint | undefined> {
    return this.data.lastProcessedBlock === undefined ? undefined : BigInt(this.data.lastProcessedBlock);
  }

  async setLastProcessedBlock(block: bigint): Promise<void> {
    if (block < 0n) throw new Error("Last processed block must be non-negative");
    this.data.lastProcessedBlock = block.toString();
  }

  async getTelegramOffset(): Promise<number | undefined> {
    return this.data.telegramOffset;
  }

  async setTelegramOffset(offset: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Telegram offset must be a non-negative integer");
    this.data.telegramOffset = offset;
  }

  async markSent(key: string, ttlSeconds = 3 * 24 * 60 * 60): Promise<boolean> {
    if (!/^0x[0-9a-f]{64}:\d+:-?\d+$/i.test(key)) throw new Error("Invalid transfer dedupe key");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("Sent-key TTL must be a positive integer");
    const now = Date.now();
    for (const [sentKey, expiry] of Object.entries(this.data.sentKeys)) {
      if (expiry <= now) delete this.data.sentKeys[sentKey];
    }
    if ((this.data.sentKeys[key] ?? 0) > now) return false;
    this.data.sentKeys[key] = now + ttlSeconds * 1000;
    return true;
  }

  async unmarkSent(key: string): Promise<void> {
    delete this.data.sentKeys[key];
  }

  async appendPriceSample(sample: { t: number; price: number }, limit: number): Promise<void> {
    if (!Number.isFinite(sample.t) || sample.t < 0 || !Number.isFinite(sample.price) || sample.price <= 0 ||
      !Number.isInteger(limit) || limit < 1 || limit > 300) {
      throw new Error("Invalid oracle price sample");
    }
    this.data.priceSamples.push(sample);
    this.data.priceSamples = this.data.priceSamples.slice(-limit);
  }

  async getPriceSamples(): Promise<{ t: number; price: number }[]> {
    return [...this.data.priceSamples];
  }

  async getPriceAlertAt(chatId: string): Promise<number | undefined> {
    validateChatId(chatId);
    return this.data.priceAlertAt[chatId];
  }

  async setPriceAlertAt(chatId: string, timestamp: number): Promise<void> {
    validateChatId(chatId);
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Invalid price-alert timestamp");
    this.data.priceAlertAt[chatId] = timestamp;
  }

  async acquireLock(instanceId: string, ttlMs: number): Promise<boolean> {
    if (inProcessLock && inProcessLock.expiresAt > Date.now() && inProcessLock.instanceId !== instanceId) return false;
    inProcessLock = { instanceId, expiresAt: Date.now() + ttlMs };
    return true;
  }

  async renewLock(instanceId: string, ttlMs: number): Promise<LockRenewalResult> {
    if (inProcessLock && inProcessLock.expiresAt > Date.now() && inProcessLock.instanceId !== instanceId) {
      return "lost";
    }
    if (!inProcessLock || inProcessLock.instanceId !== instanceId || inProcessLock.expiresAt <= Date.now()) {
      return "unavailable";
    }
    inProcessLock.expiresAt = Date.now() + ttlMs;
    return "renewed";
  }

  async releaseLock(instanceId: string): Promise<void> {
    if (inProcessLock?.instanceId === instanceId) inProcessLock = undefined;
  }

  async getMetrics(): Promise<StoreMetrics> {
    const allAddresses = new Set(Object.values(this.data.subscriptions).flatMap(Object.keys));
    return {
      redisCommands: this.redisCommands,
      chatCount: Object.keys(this.data.subscriptions).length,
      addressCount: allAddresses.size,
      errorsLastHour: this.data.errors.filter((time) => Date.now() - time < 3_600_000).length,
    };
  }

  async recordError(timestamp = Date.now()): Promise<void> {
    this.data.errors.push(timestamp);
    this.data.errors = this.data.errors.slice(-1000);
  }

  async flush(): Promise<void> {}

  protected rebuildReverseIndex(): void {
    this.reverse.clear();
    for (const [chatId, entries] of Object.entries(this.data.subscriptions)) {
      for (const address of Object.keys(entries)) {
        const chats = this.reverse.get(address) ?? new Set<string>();
        chats.add(chatId);
        this.reverse.set(address, chats);
      }
    }
  }

  private removeReverseChat(address: string, chatId: string): void {
    const chats = this.reverse.get(address);
    chats?.delete(chatId);
    if (chats?.size === 0) this.reverse.delete(address);
  }
}
