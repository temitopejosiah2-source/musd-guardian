import { chmod, copyFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { logWarn } from "./security.js";
import { z } from "zod";

/* eslint security/detect-non-literal-fs-filename: "off" -- The persisted path is explicitly operator-configured via STATE_PATH. */
const MAX_RECENT_IDS = 1000;
const MAX_STATE_BYTES = 1024 * 1024;

export type HealthLevel = "OK" | "WARN" | "DANGER";

export interface WatchState {
  lastProcessedBlock: bigint;
  recentIds: string[];
  healthLevel?: HealthLevel;
  healthFailureSinceMs?: number;
  healthFailureAlerted?: boolean;
  telegramUpdateOffset?: number;
}

const persistedStateSchema = z.object({
  lastProcessedBlock: z.string().regex(/^\d+$/),
  recentIds: z.array(z.string().max(256)).max(MAX_RECENT_IDS),
  healthLevel: z.enum(["OK", "WARN", "DANGER"]).optional(),
  healthFailureSinceMs: z.number().finite().nonnegative().optional(),
  healthFailureAlerted: z.boolean().optional(),
  telegramUpdateOffset: z.number().int().nonnegative().optional(),
});

export async function loadState(latestBlock: bigint): Promise<WatchState> {
  const statePath = getStatePath();
  try {
    return await readStateFile(statePath);
  } catch (error) {
    if (isMissingFile(error)) {
      return { lastProcessedBlock: latestBlock, recentIds: [] };
    }
    if (!(error instanceof InvalidStateFileError)) throw error;
    const backupPath = `${statePath}.bak`;
    try {
      await copyFile(statePath, backupPath);
      await chmod(backupPath, 0o600);
      logWarn("State file was invalid; preserved it as a backup and starting clean.");
      const cleanState = { lastProcessedBlock: latestBlock, recentIds: [] };
      await saveState(cleanState);
      return cleanState;
    } catch (backupError) {
      throw new Error("State file is invalid and could not be backed up", {
        cause: backupError,
      });
    }
  }
}

export async function saveState(state: WatchState): Promise<void> {
  const statePath = getStatePath();
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  const contents = JSON.stringify(
    {
      lastProcessedBlock: state.lastProcessedBlock.toString(),
      recentIds: state.recentIds.slice(-MAX_RECENT_IDS),
      ...(state.healthLevel ? { healthLevel: state.healthLevel } : {}),
      ...(state.healthFailureSinceMs !== undefined
        ? { healthFailureSinceMs: state.healthFailureSinceMs }
        : {}),
      ...(state.healthFailureAlerted !== undefined
        ? { healthFailureAlerted: state.healthFailureAlerted }
        : {}),
      ...(state.telegramUpdateOffset !== undefined
        ? { telegramUpdateOffset: state.telegramUpdateOffset }
        : {}),
    },
    null,
    2,
  );
  await mkdir(dirname(statePath), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "w", 0o600);
    await handle.writeFile(`${contents}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    try {
      await copyFile(statePath, `${statePath}.bak`);
      await chmod(`${statePath}.bak`, 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await rename(temporaryPath, statePath);
    await chmod(statePath, 0o600);
  } finally {
    await handle?.close();
  }
}

export function getStatePath(): string {
  const configuredPath = process.env.STATE_PATH?.trim() || "./state.json";
  return resolve(configuredPath);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readStateFile(path: string): Promise<WatchState> {
  const metadata = await stat(path);
  if (metadata.size > MAX_STATE_BYTES) {
    throw new InvalidStateFileError("State file is too large");
  }
  return parseState(await readFile(path, "utf8"));
}

function parseState(raw: string): WatchState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidStateFileError("Invalid state file format");
  }
  const result = persistedStateSchema.safeParse(decoded);
  if (!result.success) throw new InvalidStateFileError("Invalid state file format");
  const parsed = result.data;

  return {
    lastProcessedBlock: BigInt(parsed.lastProcessedBlock),
    recentIds: parsed.recentIds.slice(-MAX_RECENT_IDS),
    ...(parsed.healthLevel !== undefined ? { healthLevel: parsed.healthLevel } : {}),
    ...(parsed.healthFailureSinceMs !== undefined
      ? { healthFailureSinceMs: parsed.healthFailureSinceMs }
      : {}),
    ...(parsed.healthFailureAlerted !== undefined
      ? { healthFailureAlerted: parsed.healthFailureAlerted }
      : {}),
    ...(parsed.telegramUpdateOffset !== undefined
      ? { telegramUpdateOffset: parsed.telegramUpdateOffset }
      : {}),
  };
}

class InvalidStateFileError extends Error {}
