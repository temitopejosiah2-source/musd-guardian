import type { Address } from "viem";
import type { LoanHealth } from "../loan.js";

export type HealthLevel = "SAFE" | "MONITOR" | "WARNING" | "DANGER";

export interface Subscription {
  address: Address;
  label?: string;
}

export interface ChatSettings {
  monitorLtv: number;
  warnLtv: number;
  dangerLtv: number;
  transfers: boolean;
  monitorAlerts: boolean;
  priceAlerts: boolean;
  dropPercent: number;
  reminders: boolean;
}

export interface StoredLevel {
  level: HealthLevel;
  troveActive: boolean;
  health?: LoanHealth;
  reminderCount?: number;
  lastReminderAt?: number;
  snoozedUntil?: number;
  snoozeLevel?: HealthLevel;
}

export interface PriceSample {
  t: number;
  price: number;
}

export interface StoreSnapshot {
  version: 1;
  subscriptions: Record<string, Record<string, Subscription>>;
  settings: Record<string, ChatSettings>;
  levels: Record<string, Record<string, StoredLevel>>;
  lastProcessedBlock?: string;
  telegramOffset?: number;
  sentKeys: Record<string, number>;
  errors: number[];
  priceSamples: PriceSample[];
  priceAlertAt: Record<string, number>;
}

export interface Store {
  listChats(): Promise<string[]>;
  getSubscriptions(chatId: string): Promise<Subscription[]>;
  getSubscriptionsForAddress(address: Address): Promise<string[]>;
  getAllSubscriptions(): Promise<Record<string, Subscription[]>>;
  addSubscription(chatId: string, subscription: Subscription, limits: StoreLimits): Promise<void>;
  removeSubscription(chatId: string, address: Address): Promise<boolean>;
  deleteChat(chatId: string): Promise<void>;
  getSettings(chatId: string): Promise<ChatSettings>;
  setSettings(chatId: string, settings: ChatSettings): Promise<void>;
  getLevel(chatId: string, address: Address): Promise<StoredLevel | undefined>;
  setLevel(chatId: string, address: Address, level: StoredLevel): Promise<void>;
  getLastProcessedBlock(): Promise<bigint | undefined>;
  setLastProcessedBlock(block: bigint): Promise<void>;
  getTelegramOffset(): Promise<number | undefined>;
  setTelegramOffset(offset: number): Promise<void>;
  markSent(key: string, ttlSeconds?: number): Promise<boolean>;
  unmarkSent(key: string): Promise<void>;
  appendPriceSample(sample: PriceSample, limit: number): Promise<void>;
  getPriceSamples(): Promise<PriceSample[]>;
  getPriceAlertAt(chatId: string): Promise<number | undefined>;
  setPriceAlertAt(chatId: string, timestamp: number): Promise<void>;
  acquireLock(instanceId: string, ttlMs: number): Promise<boolean>;
  renewLock(instanceId: string, ttlMs: number): Promise<LockRenewalResult>;
  releaseLock(instanceId: string): Promise<void>;
  getMetrics(): Promise<StoreMetrics>;
  recordError(timestamp?: number): Promise<void>;
  flush(): Promise<void>;
}

export type LockRenewalResult = "renewed" | "lost" | "unavailable";

export interface StoreLimits {
  maxAddressesPerChat: number;
  maxChats: number;
  maxTotalAddresses: number;
}

export interface StoreMetrics {
  redisCommands: number;
  chatCount: number;
  addressCount: number;
  errorsLastHour: number;
}

export function levelStateChanged(previous: StoredLevel | undefined, next: StoredLevel): boolean {
  return previous === undefined ||
    previous.level !== next.level ||
    previous.troveActive !== next.troveActive ||
    previous.reminderCount !== next.reminderCount ||
    previous.lastReminderAt !== next.lastReminderAt ||
    previous.snoozedUntil !== next.snoozedUntil ||
    previous.snoozeLevel !== next.snoozeLevel;
}
