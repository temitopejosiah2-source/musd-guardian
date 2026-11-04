import "dotenv/config";
import { isAddress } from "viem";
import { z } from "zod";

const nonEmptyUnpadded = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());
const numeric = (
  { integer = false, min, max }: { integer?: boolean; min?: number; max?: number } = {},
) =>
  z.string().optional().refine((value) => {
    if (value === undefined) return true;
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return false;
    const parsed = Number(value);
    return (
      Number.isFinite(parsed) &&
      (!integer || Number.isInteger(parsed)) &&
      (min === undefined || parsed >= min) &&
      (max === undefined || parsed <= max)
    );
  });

const environmentSchema = z
  .object({
    WATCH_ADDRESS: nonEmptyUnpadded.optional().refine(
      (value) => value === undefined || isAddress(value),
    ),
    RPC_URL: nonEmptyUnpadded
      .optional()
      .refine((value) => {
        if (value === undefined) return true;
        try {
          const parsed = new URL(value);
          return parsed.protocol === "https:";
        } catch {
          return false;
        }
      }),
    RPC_TIMEOUT_MS: numeric({ integer: true, min: 1 }),
    TELEGRAM_TIMEOUT_MS: numeric({ integer: true, min: 2_000 }),
    REDIS_TIMEOUT_MS: numeric({ integer: true, min: 1 }),
    SIMULATE_RPC_OUTAGE_MS: numeric({ integer: true, min: 1 }),
    TELEGRAM_BOT_TOKEN: nonEmptyUnpadded
      .optional()
      .refine((value) => value === undefined || /^\d+:[A-Za-z0-9_-]{20,}$/.test(value)),
    TELEGRAM_CHAT_ID: nonEmptyUnpadded
      .optional()
      .refine((value) => value === undefined || /^-?\d+$/.test(value)),
    TELEGRAM_ALLOWED_USER_IDS: nonEmptyUnpadded
      .optional()
      .refine(
        (value) =>
          value === undefined ||
          value.split(",").every((id) => /^-?\d+$/.test(id.trim())),
      ),
    UPSTASH_REDIS_REST_URL: nonEmptyUnpadded.optional().refine((value) => {
      if (value === undefined) return true;
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }),
    UPSTASH_REDIS_REST_TOKEN: nonEmptyUnpadded.optional(),
    ADMIN_CHAT_ID: nonEmptyUnpadded.optional().refine((value) => value === undefined || /^-?\d+$/.test(value)),
    START_LOOKBACK_BLOCKS: numeric({ integer: true, min: 1 }),
    HEALTH_POLL_SECONDS: numeric({ integer: true, min: 1 }),
    MONITOR_LTV: numeric({ integer: true, min: 1, max: 88 }),
    WARN_LTV: numeric({ integer: true, min: 1, max: 89 }),
    DANGER_LTV: numeric({ integer: true, min: 1, max: 89 }),
    PRICE_SAMPLE_SECONDS: numeric({ integer: true, min: 1 }),
    PRICE_ALERT_COOLDOWN_MINUTES: numeric({ integer: true, min: 1 }),
    PRICE_MAX_AGE_SECONDS: numeric({ integer: true, min: 1 }),
    REMIND_DANGER_MINUTES: numeric({ integer: true, min: 1 }),
    REMIND_MAX: numeric({ integer: true, min: 1 }),
    PORT: numeric({ integer: true, min: 1, max: 65535 }),
    STATE_PATH: nonEmptyUnpadded.optional(),
    STORE: z.enum(["redis", "file", "memory"]).optional(),
    MAX_ADDRESSES_PER_CHAT: numeric({ integer: true, min: 1 }),
    MAX_CHATS: numeric({ integer: true, min: 1 }),
    MAX_TOTAL_ADDRESSES: numeric({ integer: true, min: 1 }),
  })
  .superRefine((env, context) => {
    const monitor = Number(env.MONITOR_LTV ?? "55");
    const warn = Number(env.WARN_LTV ?? "70");
    const danger = Number(env.DANGER_LTV ?? "80");
    if (monitor >= warn || warn >= danger || danger >= 90) {
      context.addIssue({
        code: "custom",
        path: ["MONITOR_LTV"],
        message: "thresholds must satisfy MONITOR_LTV < WARN_LTV < DANGER_LTV < 90",
      });
    }
  });

export function validateEnvironment(): void {
  const result = environmentSchema.safeParse(process.env);
  if (result.success) return;

  const fields = [
    ...new Set(
      result.error.issues.map((issue) => issue.path[0]).filter(
        (field): field is string => typeof field === "string",
      ),
    ),
  ];
  throw new Error(
    fields.length > 0
      ? `Invalid environment configuration: ${fields.join(", ")}`
      : "Invalid environment configuration",
  );
}
