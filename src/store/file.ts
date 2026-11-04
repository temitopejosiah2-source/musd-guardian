import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { logWarn } from "../security.js";
import { MemoryStore } from "./memory.js";
import { emptySnapshot, parseSnapshot } from "./validation.js";
import type { Address } from "viem";
import { levelStateChanged, type ChatSettings, type StoreLimits, type StoredLevel, type Subscription } from "./types.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/* eslint security/detect-non-literal-fs-filename: "off" -- Paths are resolved from the operator-configured store path. */
export class FileStore extends MemoryStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private lockHandle: Awaited<ReturnType<typeof open>> | undefined;

  private constructor(path: string) {
    super();
    this.path = path;
  }

  static async open(path = process.env.STATE_PATH?.trim() || "./state.json"): Promise<FileStore> {
    const store = new FileStore(resolve(path));
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    try {
      const metadata = await stat(this.path);
      if (metadata.size > MAX_FILE_BYTES) throw new Error("Store file is too large");
      const decoded: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        typeof decoded === "object" && decoded !== null &&
        "version" in decoded && decoded.version === 1
      ) {
        this.data = parseSnapshot(decoded);
        this.rebuildReverseIndex();
      } else if (
        typeof decoded === "object" && decoded !== null &&
        "lastProcessedBlock" in decoded &&
        typeof decoded.lastProcessedBlock === "string" &&
        /^\d+$/.test(decoded.lastProcessedBlock)
      ) {
        this.data = emptySnapshot();
        this.data.lastProcessedBlock = decoded.lastProcessedBlock;
      } else {
        throw new Error("Invalid store file");
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      const backupPath = `${this.path}.bak`;
      try {
        await copyFile(this.path, backupPath);
        await chmod(backupPath, 0o600);
        logWarn("Store file was invalid; preserved it as a backup and starting clean.");
        this.data = emptySnapshot();
        this.rebuildReverseIndex();
        await this.persist();
      } catch (backupError) {
        if (isMissingFile(backupError)) return;
        throw new Error("Store file is invalid and could not be backed up", { cause: backupError });
      }
    }
  }

  private async persist(): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const tempPath = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(tempPath, "w", 0o600);
        await handle.writeFile(`${JSON.stringify(this.data, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await chmod(tempPath, 0o600);
        try {
          await copyFile(this.path, `${this.path}.bak`);
          await chmod(`${this.path}.bak`, 0o600);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
        await rename(tempPath, this.path);
        await chmod(this.path, 0o600);
      } finally {
        await handle?.close();
      }
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }

  override async addSubscription(chatId: string, value: Subscription, limits: StoreLimits): Promise<void> {
    await super.addSubscription(chatId, value, limits);
    await this.persist();
  }

  override async removeSubscription(chatId: string, address: Address): Promise<boolean> {
    const removed = await super.removeSubscription(chatId, address);
    if (removed) await this.persist();
    return removed;
  }

  override async deleteChat(chatId: string): Promise<void> {
    await super.deleteChat(chatId);
    await this.persist();
  }

  override async setSettings(chatId: string, settings: ChatSettings): Promise<void> {
    await super.setSettings(chatId, settings);
    await this.persist();
  }

  override async setLevel(chatId: string, address: Address, level: StoredLevel): Promise<void> {
    const before = await super.getLevel(chatId, address);
    await super.setLevel(chatId, address, level);
    if (levelStateChanged(before, level)) await this.persist();
  }

  override async setLastProcessedBlock(block: bigint): Promise<void> {
    await super.setLastProcessedBlock(block);
    await this.persist();
  }

  override async setTelegramOffset(offset: number): Promise<void> {
    await super.setTelegramOffset(offset);
    await this.persist();
  }

  override async markSent(key: string, ttlSeconds?: number): Promise<boolean> {
    const marked = await super.markSent(key, ttlSeconds);
    if (marked) await this.persist();
    return marked;
  }

  override async unmarkSent(key: string): Promise<void> {
    await super.unmarkSent(key);
    await this.persist();
  }

  override async appendPriceSample(sample: { t: number; price: number }, limit: number): Promise<void> {
    await super.appendPriceSample(sample, limit);
    await this.persist();
  }

  override async setPriceAlertAt(chatId: string, timestamp: number): Promise<void> {
    await super.setPriceAlertAt(chatId, timestamp);
    await this.persist();
  }

  override async acquireLock(instanceId: string, ttlMs: number): Promise<boolean> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ instanceId, expiresAt: Date.now() + ttlMs }));
      await handle.sync();
      this.lockHandle = handle;
      this.lockId = instanceId;
      this.lockUntil = Date.now() + ttlMs;
      return true;
    } catch (error) {
      await handle?.close();
      if (!isExists(error)) throw error;
      try {
        const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
        if (
          typeof current === "object" && current !== null && "expiresAt" in current &&
          typeof current.expiresAt === "number" && current.expiresAt < Date.now()
        ) {
          await this.lockHandle?.close();
          this.lockHandle = undefined;
          this.lockId = undefined;
          await unlink(lockPath);
          return this.acquireLock(instanceId, ttlMs);
        }
      } catch (readError) {
        if (!isMissingFile(readError)) throw readError;
        return this.acquireLock(instanceId, ttlMs);
      }
      return false;
    }
  }

  override async renewLock(instanceId: string, ttlMs: number): Promise<"renewed" | "lost" | "unavailable"> {
    const lockPath = `${this.path}.lock`;
    try {
      const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (
        typeof current !== "object" || current === null ||
        !("instanceId" in current) || !("expiresAt" in current) ||
        typeof current.expiresAt !== "number"
      ) return "unavailable";
      if (current.instanceId !== instanceId) return "lost";
      if (
        this.lockId !== instanceId || this.lockUntil <= Date.now() ||
        current.expiresAt <= Date.now() || !this.lockHandle
      ) return "unavailable";
      const currentPathStats = await stat(lockPath);
      const heldFileStats = await this.lockHandle.stat();
      if (currentPathStats.dev !== heldFileStats.dev || currentPathStats.ino !== heldFileStats.ino) return "lost";
      const contents = JSON.stringify({ instanceId, expiresAt: Date.now() + ttlMs });
      await this.lockHandle.truncate(0);
      await this.lockHandle.write(contents, 0, "utf8");
      await this.lockHandle.sync();
      const updatedPathStats = await stat(lockPath);
      const updatedHeldStats = await this.lockHandle.stat();
      if (updatedPathStats.dev !== updatedHeldStats.dev || updatedPathStats.ino !== updatedHeldStats.ino) return "lost";
      this.lockUntil = Date.now() + ttlMs;
      return "renewed";
    } catch (error) {
      if (isMissingFile(error)) return "unavailable";
      throw error;
    }
  }

  override async releaseLock(instanceId: string): Promise<void> {
    if (this.lockId !== instanceId) return;
    const lockPath = `${this.path}.lock`;
    try {
      const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      const pathStats = await stat(lockPath);
      const heldStats = await this.lockHandle?.stat();
      if (
        typeof current === "object" && current !== null &&
        "instanceId" in current && current.instanceId === instanceId &&
        pathStats.dev === heldStats?.dev && pathStats.ino === heldStats?.ino
      ) await unlink(lockPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    } finally {
      await this.lockHandle?.close();
      this.lockHandle = undefined;
      this.lockId = undefined;
    }
  }

  override async flush(): Promise<void> {
    await this.writeQueue;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
