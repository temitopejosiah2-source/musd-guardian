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
    START_LOOKBACK_BLOCKS: numeric({ integer: true, min: 1 }),
    HEALTH_POLL_SECONDS: numeric({ integer: true, min: 1 }),
    WARN_LTV: numeric({ min: 0, max: 100 }),
    DANGER_LTV: numeric({ min: 0, max: 100 }),
    PORT: numeric({ integer: true, min: 1, max: 65535 }),
    STATE_PATH: nonEmptyUnpadded.optional(),
  })
  .superRefine((env, context) => {
    const warn = Number(env.WARN_LTV ?? "70");
    const danger = Number(env.DANGER_LTV ?? "80");
    if (danger <= warn) {
      context.addIssue({
        code: "custom",
        path: ["DANGER_LTV"],
        message: "must be greater than WARN_LTV",
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
