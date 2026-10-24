import "dotenv/config";
import { defineChain, isAddress, type Address } from "viem";

export const chain = defineChain({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.test.mezo.org"] },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: "https://explorer.test.mezo.org" },
  },
});

export const MUSD_ADDRESS =
  "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" as const satisfies Address;
// Resolved from BorrowerOperations getters in the supplied openTrove transaction.
export const TROVE_MANAGER_ADDRESS =
  "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0" as const satisfies Address;
// Resolved from BorrowerOperations.priceFeed() in the supplied openTrove transaction.
export const PRICE_FEED_ADDRESS =
  "0x86bCF0841622a5dAC14A313a15f96A95421b9366" as const satisfies Address;
export const EXPLORER_URL = "https://explorer.test.mezo.org";
function getRpcUrl(): string {
  const value = process.env.RPC_URL?.trim() || "https://rpc.test.mezo.org";
  try {
    if (new URL(value).protocol !== "https:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error("RPC_URL must be a valid HTTPS URL");
  }
  return value;
}

export const RPC_URL = getRpcUrl();

export function getWatchAddress(): Address {
  const value = process.env.WATCH_ADDRESS?.trim();
  if (!value) throw new Error("Missing required environment variable: WATCH_ADDRESS");
  if (!isAddress(value)) {
    throw new Error("WATCH_ADDRESS must be a valid EVM address");
  }
  return value;
}

export function getStartLookbackBlocks(): bigint {
  const rawValue = process.env.START_LOOKBACK_BLOCKS?.trim() || "5000";
  if (!/^\d+$/.test(rawValue) || BigInt(rawValue) <= 0n) {
    throw new Error("START_LOOKBACK_BLOCKS must be a positive whole number");
  }
  return BigInt(rawValue);
}

export function getTelegramConfig(): { token: string; chatId: string } {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token) throw new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("Missing required environment variable: TELEGRAM_CHAT_ID");
  return {
    token,
    chatId,
  };
}

export interface HealthAlertConfig {
  pollSeconds: number;
  warnLtv: number;
  dangerLtv: number;
}

export function getHealthAlertConfig(): HealthAlertConfig {
  const pollSeconds = parsePositiveNumber("HEALTH_POLL_SECONDS", 60);
  const warnLtv = parsePositiveNumber("WARN_LTV", 70);
  const dangerLtv = parsePositiveNumber("DANGER_LTV", 80);
  if (dangerLtv <= warnLtv || dangerLtv > 100 || warnLtv > 100) {
    throw new Error("DANGER_LTV must be greater than WARN_LTV, and both must be at most 100");
  }
  if (!Number.isInteger(pollSeconds)) {
    throw new Error("HEALTH_POLL_SECONDS must be a positive whole number");
  }
  return { pollSeconds, warnLtv, dangerLtv };
}

function parsePositiveNumber(
  name: "HEALTH_POLL_SECONDS" | "WARN_LTV" | "DANGER_LTV",
  defaultValue: number,
): number {
  const rawValue =
    name === "HEALTH_POLL_SECONDS"
      ? process.env.HEALTH_POLL_SECONDS?.trim()
      : name === "WARN_LTV"
        ? process.env.WARN_LTV?.trim()
        : process.env.DANGER_LTV?.trim();
  if (!rawValue) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}
