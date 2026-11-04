import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import type { ChatSettings, StoredLevel, StoreSnapshot, Subscription } from "./types.js";

export function normalizeAddress(value: string): Address {
  if (!isAddress(value, { strict: true })) throw new Error("Address is invalid");
  const address = getAddress(value);
  if (/^0x0{40}$/i.test(address)) throw new Error("The zero address cannot be watched");
  return address;
}

export function validateLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 24 || !/^[A-Za-z0-9 _-]+$/.test(value)) {
    throw new Error("Label must be 1-24 letters, numbers, spaces, dashes, or underscores");
  }
  return value;
}

export function defaultSettings(): ChatSettings {
  const monitorLtv = Number(process.env.MONITOR_LTV ?? 55);
  const warnLtv = Number(process.env.WARN_LTV ?? 70);
  const dangerLtv = Number(process.env.DANGER_LTV ?? 80);
  return validateSettings({
    monitorLtv,
    warnLtv,
    dangerLtv,
    transfers: true,
    monitorAlerts: false,
    priceAlerts: true,
    dropPercent: 5,
    reminders: true,
  });
}

const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/i);
const subscriptionSchema = z.object({
  address: addressSchema,
  label: z.string().min(1).max(24).regex(/^[A-Za-z0-9 _-]+$/).optional(),
});
const settingsSchema = z.object({
  monitorLtv: z.number().int().min(1).max(88).default(55),
  warnLtv: z.number().int().min(1).max(89),
  dangerLtv: z.number().int().min(1).max(89),
  transfers: z.boolean(),
  monitorAlerts: z.boolean().default(false),
  priceAlerts: z.boolean().default(true),
  dropPercent: z.number().finite().min(1).max(50).default(5),
  reminders: z.boolean().default(true),
}).refine((value) => value.monitorLtv < value.warnLtv && value.warnLtv < value.dangerLtv && value.dangerLtv < 90);
const healthSchema = z.object({
  collateralBtc: z.number().finite(),
  debtMusd: z.number().finite(),
  btcPriceUsd: z.number().finite(),
  collateralValueUsd: z.number().finite(),
  ltvPercent: z.number().finite(),
  liquidationLtvPercent: z.number().finite(),
  distanceToLiquidationPercent: z.number().finite(),
  troveActive: z.boolean(),
  rawValues: z.object({
    collateral: z.string(),
    debt: z.string(),
    btcPrice: z.string(),
    decimalPrecision: z.string(),
    troveStatus: z.number().int(),
    musdDecimals: z.number().int(),
    collateralDecimals: z.number().int(),
    priceDecimals: z.number().int(),
  }),
});
const levelSchema = z.object({
  level: z.enum(["SAFE", "MONITOR", "WARNING", "DANGER", "OK", "WARN"]),
  troveActive: z.boolean(),
  health: healthSchema.optional(),
  reminderCount: z.number().int().nonnegative().optional(),
  lastReminderAt: z.number().finite().optional(),
  snoozedUntil: z.number().finite().optional(),
  snoozeLevel: z.enum(["SAFE", "MONITOR", "WARNING", "DANGER"]).optional(),
});
const snapshotSchema = z.object({
  version: z.literal(1),
  subscriptions: z.record(z.string().regex(/^-?\d+$/), z.record(addressSchema, subscriptionSchema)),
  settings: z.record(z.string().regex(/^-?\d+$/), settingsSchema),
  levels: z.record(z.string().regex(/^-?\d+$/), z.record(addressSchema, levelSchema)),
  lastProcessedBlock: z.string().regex(/^\d+$/).optional(),
  telegramOffset: z.number().int().nonnegative().optional(),
  sentKeys: z.record(z.string().regex(/^0x[0-9a-f]{64}:\d+:-?\d+$/i), z.number().finite()),
  errors: z.array(z.number().finite()).max(1000),
  priceSamples: z.array(z.object({ t: z.number().finite().nonnegative(), price: z.number().finite().positive() })).max(300).default([]),
  priceAlertAt: z.record(z.string().regex(/^-?\d+$/), z.number().finite()).default({}),
});

export function validateSettings(settings: ChatSettings): ChatSettings {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) throw new Error("Monitor, warn, and danger thresholds must satisfy 1 <= monitor < warn < danger < 90");
  return parsed.data;
}

export function validateSubscription(subscription: Subscription): Subscription {
  const address = normalizeAddress(subscription.address);
  const label = validateLabel(subscription.label);
  return { address: address.toLowerCase() as Address, ...(label ? { label } : {}) };
}

export function parseSnapshot(value: unknown): StoreSnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid store file");
  for (const chat of Object.values(parsed.data.subscriptions)) {
    for (const [key, subscription] of Object.entries(chat)) {
      if (key !== key.toLowerCase() || key !== subscription.address) {
        throw new Error("Invalid store file");
      }
    }
  }
  for (const levels of Object.values(parsed.data.levels)) {
    for (const key of Object.keys(levels)) {
      if (key !== key.toLowerCase()) throw new Error("Invalid store file");
      }
  }
  const data = parsed.data;
  for (const levels of Object.values(data.levels)) {
    for (const level of Object.values(levels)) {
      if (level.level === "OK") level.level = "SAFE";
      if (level.level === "WARN") level.level = "WARNING";
    }
  }
  return data as StoreSnapshot;
}

export function validateChatId(value: string): string {
  if (!/^-?\d{1,20}$/.test(value)) throw new Error("Invalid Telegram chat");
  return value;
}

export function emptySnapshot(): StoreSnapshot {
  return {
    version: 1,
    subscriptions: {},
    settings: {},
    levels: {},
    sentKeys: {},
    errors: [],
    priceSamples: [],
    priceAlertAt: {},
  };
}

export type { StoredLevel };
