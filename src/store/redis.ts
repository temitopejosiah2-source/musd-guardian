import { Redis } from "@upstash/redis";
import type { Address } from "viem";
import { MemoryStore } from "./memory.js";
import { parseSnapshot } from "./validation.js";
import { levelStateChanged, type ChatSettings, type StoreLimits, type StoredLevel, type Subscription } from "./types.js";
import { validateChatId } from "./validation.js";
import { getTimeoutMs } from "../config.js";

const SNAPSHOT_KEY = "musd-guardian:v1:snapshot";
const LOCK_KEY = "musd-guardian:v1:lock:poller";
const SENT_KEY_PREFIX = "musd-guardian:v1:sent:";
const CACHE_REFRESH_MS = 60_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export class UpstashStore extends MemoryStore {
  private readonly redis: Redis;
  private lastRefresh = 0;
  private writes = Promise.resolve();
  private localErrors: number[] = [];

  constructor(redis = Redis.fromEnv({ signal: () => AbortSignal.timeout(getTimeoutMs("REDIS_TIMEOUT_MS")) })) {
    super();
    this.redis = redis;
  }

  async initialize(): Promise<void> {
    await this.refresh(true);
  }

  private async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.lastRefresh < CACHE_REFRESH_MS) return;
    const snapshot = await this.redis.get<unknown>(SNAPSHOT_KEY);
    this.redisCommands += 1;
    if (snapshot !== null) {
      if (typeof snapshot === "string" && Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) {
        throw new Error("Redis store snapshot is too large");
      }
      this.data = parseSnapshot(typeof snapshot === "string" ? JSON.parse(snapshot) as unknown : snapshot);
      this.data.errors = [...this.data.errors, ...this.localErrors].slice(-1000);
      this.rebuildReverseIndex();
    }
    this.lastRefresh = Date.now();
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    if (Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) {
      throw new Error("Redis store snapshot is too large");
    }
    this.writes = this.writes.then(async () => {
      const pipeline = this.redis.pipeline();
      pipeline.set(SNAPSHOT_KEY, snapshot);
      await pipeline.exec();
      this.redisCommands += 1;
    });
    await this.writes;
  }

  override async listChats(): Promise<string[]> {
    await this.refresh();
    return super.listChats();
  }

  override async getSubscriptions(chatId: string): Promise<Subscription[]> {
    await this.refresh();
    return super.getSubscriptions(chatId);
  }

  override async getSubscriptionsForAddress(address: Address): Promise<string[]> {
    await this.refresh();
    return super.getSubscriptionsForAddress(address);
  }

  override async getAllSubscriptions(): Promise<Record<string, Subscription[]>> {
    await this.refresh();
    return super.getAllSubscriptions();
  }

  override async addSubscription(chatId: string, value: Subscription, limits: StoreLimits): Promise<void> {
    await this.refresh();
    await super.addSubscription(chatId, value, limits);
    await this.persist();
  }

  override async removeSubscription(chatId: string, address: Address): Promise<boolean> {
    await this.refresh();
    const removed = await super.removeSubscription(chatId, address);
    if (removed) await this.persist();
    return removed;
  }

  override async deleteChat(chatId: string): Promise<void> {
    validateChatId(chatId);
    await this.refresh();
    const sentKeys = await this.redis.keys(`${SENT_KEY_PREFIX}*:${chatId}`);
    this.redisCommands += 1;
    if (sentKeys.length > 0) {
      for (let index = 0; index < sentKeys.length; index += 100) {
        const pipeline = this.redis.pipeline();
        pipeline.del(...sentKeys.slice(index, index + 100));
        await pipeline.exec();
        this.redisCommands += Math.min(100, sentKeys.length - index);
      }
    }
    await super.deleteChat(chatId);
    await this.persist();
  }

  override async getSettings(chatId: string): Promise<ChatSettings> {
    await this.refresh();
    return super.getSettings(chatId);
  }

  override async setSettings(chatId: string, settings: ChatSettings): Promise<void> {
    await this.refresh();
    await super.setSettings(chatId, settings);
    await this.persist();
  }

  override async getLevel(chatId: string, address: Address): Promise<StoredLevel | undefined> {
    await this.refresh();
    return super.getLevel(chatId, address);
  }

  override async setLevel(chatId: string, address: Address, level: StoredLevel): Promise<void> {
    await this.refresh();
    const before = await super.getLevel(chatId, address);
    await super.setLevel(chatId, address, level);
    if (levelStateChanged(before, level)) await this.persist();
  }

  override async getLastProcessedBlock(): Promise<bigint | undefined> {
    await this.refresh();
    return super.getLastProcessedBlock();
  }

  override async setLastProcessedBlock(block: bigint): Promise<void> {
    await this.refresh();
    await super.setLastProcessedBlock(block);
    await this.persist();
  }

  override async getTelegramOffset(): Promise<number | undefined> {
    await this.refresh();
    return super.getTelegramOffset();
  }

  override async setTelegramOffset(offset: number): Promise<void> {
    await this.refresh();
    await super.setTelegramOffset(offset);
    await this.persist();
  }

  override async markSent(key: string, ttlSeconds = 3 * 24 * 60 * 60): Promise<boolean> {
    if (!/^0x[0-9a-f]{64}:\d+:-?\d+$/i.test(key)) throw new Error("Invalid transfer dedupe key");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("Sent-key TTL must be a positive integer");
    const result = await this.redis.set(`${SENT_KEY_PREFIX}${key}`, "1", {
      nx: true,
      ex: ttlSeconds,
    });
    this.redisCommands += 1;
    return result === "OK";
  }

  override async unmarkSent(key: string): Promise<void> {
    if (!/^0x[0-9a-f]{64}:\d+:-?\d+$/i.test(key)) throw new Error("Invalid transfer dedupe key");
    await this.redis.del(`${SENT_KEY_PREFIX}${key}`);
    this.redisCommands += 1;
  }

  override async appendPriceSample(sample: { t: number; price: number }, limit: number): Promise<void> {
    await this.refresh();
    await super.appendPriceSample(sample, limit);
    await this.persist();
  }

  override async getPriceSamples(): Promise<{ t: number; price: number }[]> {
    await this.refresh();
    return super.getPriceSamples();
  }

  override async getPriceAlertAt(chatId: string): Promise<number | undefined> {
    await this.refresh();
    return super.getPriceAlertAt(chatId);
  }

  override async setPriceAlertAt(chatId: string, timestamp: number): Promise<void> {
    await this.refresh();
    await super.setPriceAlertAt(chatId, timestamp);
    await this.persist();
  }

  override async acquireLock(instanceId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(LOCK_KEY, instanceId, { nx: true, px: ttlMs });
    this.redisCommands += 1;
    return result === "OK";
  }

  override async renewLock(instanceId: string, ttlMs: number): Promise<"renewed" | "lost" | "unavailable"> {
    const result = await this.redis.eval<[string, string], number>(
      "local owner = redis.call('get', KEYS[1]); if not owner then return 0 end; if owner ~= ARGV[1] then return 2 end; return redis.call('pexpire', KEYS[1], ARGV[2])",
      [LOCK_KEY],
      [instanceId, String(ttlMs)],
    );
    this.redisCommands += 1;
    return result === 1 ? "renewed" : result === 2 ? "lost" : "unavailable";
  }

  override async releaseLock(instanceId: string): Promise<void> {
    await this.redis.eval<[string], number>(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [LOCK_KEY],
      [instanceId],
    );
    this.redisCommands += 1;
  }

  override async getMetrics() {
    await this.refresh();
    const metrics = await super.getMetrics();
    return { ...metrics, redisCommands: this.redisCommands };
  }

  override async recordError(timestamp = Date.now()): Promise<void> {
    await this.refresh();
    this.localErrors.push(timestamp);
    this.localErrors = this.localErrors.slice(-1000);
    await super.recordError(timestamp);
  }

  override async flush(): Promise<void> {
    await this.writes;
  }
}
