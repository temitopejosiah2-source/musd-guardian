import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Address, type Log } from "viem";
import { BotCommands, formatHealth } from "./bot.js";
import {
  alertKeyboard,
  detectPriceDrop,
  processPriceDropAlerts,
  processTransferRange,
  runHealthCycle,
  transitionLevel,
} from "./monitor.js";
import { OutboundQueue } from "./outbound.js";
import { MUSD_ADDRESS } from "./config.js";
import { CommandRateLimiter } from "./rate-limit.js";
import { FileStore } from "./store/file.js";
import { MemoryStore } from "./store/memory.js";
import { UpstashStore } from "./store/redis.js";
import { normalizeAddress, validateLabel } from "./store/validation.js";
import { musdAbi } from "./musd.js";
import type { LoanHealth } from "./loan.js";
import type { Store, StoreLimits } from "./store/index.js";
import { TelegramApiError, type TelegramUpdate } from "./telegram.js";

/* eslint security/detect-non-literal-fs-filename: "off" -- Test paths are created inside unique temporary directories. */
const address = "0x0000000000000000000000000000000000000001" as const;
const chatId = "987654321";
const limits: StoreLimits = { maxAddressesPerChat: 1, maxChats: 2, maxTotalAddresses: 2 };
interface FakeRedisEntry {
  value: string;
  expiresAt?: number;
}

class FakeUpstashClient {
  private readonly values = new Map<string, FakeRedisEntry>();
  private clockOffset = 0;
  lastSetOptions: { nx?: boolean; ex?: number; px?: number } | undefined;

  advance(milliseconds: number): void {
    this.clockOffset += milliseconds;
  }

  async get<T>(key: string): Promise<T | null> {
    this.removeExpired(key);
    const entry = this.values.get(key);
    if (!entry) return null;
    return (entry.value as T);
  }

  pipeline() {
    const commands: Array<{ kind: "set"; key: string; value: string } | { kind: "del"; keys: string[] }> = [];
    const pipeline = {
      set: (key: string, value: string) => {
        commands.push({ kind: "set", key, value });
        return pipeline;
      },
      del: (...keys: string[]) => {
        commands.push({ kind: "del", keys });
        return pipeline;
      },
      exec: async () => {
        for (const command of commands) {
          if (command.kind === "set") this.write(command.key, command.value);
          else for (const key of command.keys) this.values.delete(key);
        }
        return [];
      },
    };
    return pipeline;
  }

  async keys(pattern: string): Promise<string[]> {
    const wildcard = pattern.indexOf("*");
    const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
    const suffix = wildcard < 0 ? "" : pattern.slice(wildcard + 1);
    for (const key of this.values.keys()) this.removeExpired(key);
    return [...this.values.keys()].filter((key) => key.startsWith(prefix) && key.endsWith(suffix));
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean; ex?: number; px?: number },
  ): Promise<string | null> {
    this.lastSetOptions = options;
    this.removeExpired(key);
    if (options?.nx && this.values.has(key)) return null;
    this.write(
      key,
      value,
      options?.ex === undefined ? options?.px : options.ex * 1000,
    );
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) removed += Number(this.values.delete(key));
    return removed;
  }

  async eval<TArgs extends string[], TResult>(
    script: string,
    keys: string[],
    args: TArgs,
  ): Promise<TResult> {
    const key = keys[0]!;
    this.removeExpired(key);
    const entry = this.values.get(key);
    let result: number;
    if (script.includes("pexpire")) {
      if (!entry) result = 0;
      else if (entry.value !== args[0]) result = 2;
      else {
        entry.expiresAt = this.clock + Number(args[1]);
        result = 1;
      }
    } else {
      result = entry?.value === args[0] ? Number(this.values.delete(key)) : 0;
    }
    return result as TResult;
  }

  private write(key: string, value: string, ttlMs?: number): void {
    this.values.set(key, {
      value,
      ...(ttlMs === undefined ? {} : { expiresAt: this.clock + ttlMs }),
    });
  }

  private removeExpired(key: string): void {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.clock) this.values.delete(key);
  }

  private get clock(): number {
    return Date.now() + this.clockOffset;
  }
}

async function openRedisStore(client: FakeUpstashClient): Promise<UpstashStore> {
  const store = new UpstashStore(client);
  await store.initialize();
  return store;
}

async function withStore(name: string, exercise: (store: Store) => Promise<void>): Promise<void> {
  if (name === "memory") {
    await exercise(new MemoryStore());
    return;
  }
  if (name === "redis") {
    await exercise(await openRedisStore(new FakeUpstashClient()));
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "musd-guardian-store-"));
  try {
    await exercise(await FileStore.open(join(directory, "state.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Store contract", () => {
  it.each(["memory", "file", "redis"])("%s persists subscriptions, settings, offsets and dedupe", async (name) => {
    await withStore(name, async (store) => {
    await store.addSubscription(chatId, { address, label: "vault 1" }, limits);
    expect(await store.getSubscriptions(chatId)).toEqual([{ address, label: "vault 1" }]);
    expect(await store.getSubscriptionsForAddress(address)).toEqual([chatId]);
    const defaults = await store.getSettings(chatId);
    await store.setSettings(chatId, { ...defaults, monitorLtv: 50, warnLtv: 65, dangerLtv: 82, transfers: false });
    expect(await store.getSettings(chatId)).toEqual({
      monitorLtv: 50, warnLtv: 65, dangerLtv: 82, transfers: false,
      monitorAlerts: false, priceAlerts: true, dropPercent: 5, reminders: true,
    });
    await store.setLastProcessedBlock(42n);
    await store.setTelegramOffset(9);
    expect(await store.getLastProcessedBlock()).toBe(42n);
    expect(await store.getTelegramOffset()).toBe(9);
    const dedupeKey = `0x${"a".repeat(64)}:0:${chatId}`;
    expect(await store.markSent(dedupeKey)).toBe(true);
    expect(await store.markSent(dedupeKey)).toBe(false);
    await store.flush();
    });
  });

  it.each(["memory", "file", "redis"])("%s locks, removes addresses, and deletes chat data", async (name) => {
    await withStore(name, async (store) => {
    expect(await store.acquireLock("instance-a", 60_000)).toBe(true);
    expect(await store.acquireLock("instance-b", 60_000)).toBe(false);
    expect(await store.renewLock("instance-a", 60_000)).toBe("renewed");
    expect(await store.renewLock("instance-b", 60_000)).toBe("lost");
    await store.addSubscription(chatId, { address }, limits);
    expect(await store.removeSubscription(chatId, address)).toBe(true);
    await store.addSubscription(chatId, { address }, limits);
    const sentKey = `0x${"a".repeat(64)}:0:${chatId}`;
    expect(await store.markSent(sentKey)).toBe(true);
    await store.deleteChat(chatId);
    expect(await store.listChats()).toEqual([]);
    expect(await store.markSent(sentKey)).toBe(true);
    await store.releaseLock("instance-a");
    expect(await store.acquireLock("instance-b", 60_000)).toBe(true);
    await store.releaseLock("instance-b");
    });
  }, 15_000);

  it("uses Redis NX and the requested TTL for sent-key deduplication", async () => {
    const client = new FakeUpstashClient();
    const store = await openRedisStore(client);
    const key = `0x${"b".repeat(64)}:2:${chatId}`;

    expect(await store.markSent(key, 2)).toBe(true);
    expect(client.lastSetOptions).toEqual({ nx: true, ex: 2 });
    expect(await store.markSent(key, 2)).toBe(false);
    client.advance(2_000);
    expect(await store.markSent(key, 2)).toBe(true);
  });

  it("restores Redis subscriptions, settings, and offsets after a restart", async () => {
    const client = new FakeUpstashClient();
    const store = await openRedisStore(client);
    await store.addSubscription(chatId, { address, label: "vault 1" }, limits);
    const settings = await store.getSettings(chatId);
    await store.setSettings(chatId, { ...settings, monitorLtv: 51 });
    await store.setLastProcessedBlock(42n);
    await store.setTelegramOffset(9);
    await store.flush();

    const restarted = await openRedisStore(client);
    expect(await restarted.getSubscriptions(chatId)).toEqual([{ address, label: "vault 1" }]);
    expect((await restarted.getSettings(chatId)).monitorLtv).toBe(51);
    expect(await restarted.getLastProcessedBlock()).toBe(42n);
    expect(await restarted.getTelegramOffset()).toBe(9);
  });

  it("enforces chat and unique-address limits", async () => {
    const store = new MemoryStore();
    const first = "0x0000000000000000000000000000000000000001" as const;
    const second = "0x0000000000000000000000000000000000000002" as const;
    const capped = { maxAddressesPerChat: 5, maxChats: 2, maxTotalAddresses: 1 };
    await store.addSubscription("10", { address: first }, capped);
    await store.addSubscription("11", { address: first }, capped);
    await expect(store.addSubscription("12", { address: first }, capped)).rejects.toThrow("Chat limit reached");
    await expect(store.addSubscription("11", { address: second }, capped)).rejects.toThrow("Total address limit reached");
  });

  it.each(["memory", "file", "redis"])("%s recovers from an expired lock without releasing the new owner", async (name) => {
    const directory = await mkdtemp(join(tmpdir(), "musd-guardian-lock-"));
    try {
      const redis = new FakeUpstashClient();
      const first = name === "memory"
        ? new MemoryStore()
        : name === "redis"
          ? await openRedisStore(redis)
          : await FileStore.open(join(directory, "state.json"));
      const second = name === "memory"
        ? new MemoryStore()
        : name === "redis"
          ? await openRedisStore(redis)
          : await FileStore.open(join(directory, "state.json"));
      expect(await first.acquireLock("first", 20)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await first.renewLock("first", 1000)).toBe("unavailable");
      expect(await second.acquireLock("second", 1000)).toBe(true);
      await first.releaseLock("first");
      expect(await second.renewLock("second", 1000)).toBe("renewed");
      await second.releaseLock("second");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a corrupt file into a fresh mode-0600 store with a backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "musd-guardian-corrupt-"));
    const path = join(directory, "state.json");
    try {
      await writeFile(path, '{"version":1,"subscriptions":"bad"}', { mode: 0o600 });
      await chmod(path, 0o600);
      const store = await FileStore.open(path);
      expect(await store.listChats()).toEqual([]);
      expect(await readFile(`${path}.bak`, "utf8")).toContain('"subscriptions":"bad"');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(`${path}.bak`)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("address and label validation", () => {
  it("normalizes valid strict addresses and rejects zero and malformed values", () => {
    expect(normalizeAddress(address)).toBe(address);
    expect(normalizeAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")).toBe(
      "0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD",
    );
    expect(() => normalizeAddress("0x0000000000000000000000000000000000000000")).toThrow();
    expect(() => normalizeAddress("not-an-address")).toThrow();
    expect(() => normalizeAddress("0x00000000000000000000000000000000000000aA")).toThrow();
  });

  it("accepts bounded labels and rejects unsupported characters", () => {
    expect(validateLabel("My Trove_1")).toBe("My Trove_1");
    expect(() => validateLabel("x".repeat(25))).toThrow();
    expect(() => validateLabel("no!")).toThrow();
  });
});

describe("multi-user commands", () => {
  function update(text: string): TelegramUpdate {
    return { updateId: 1, chatId: 12345, chatType: "private", senderId: 12345, senderIsBot: false, text };
  }

  it("watches, lists, and unwatches within address limits", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    const bot = new BotCommands({
      store,
      send: async (_chat, text) => { messages.push(text); },
      getHealth: async () => fakeHealth(),
    });
    await bot.handle(update(`/watch ${address} Main`));
    expect(await store.getSubscriptions("12345")).toEqual([{ address, label: "Main" }]);
    await bot.handle(update("/list"));
    expect(messages.at(-1)).toContain("Main:");
    for (let index = 2; index <= 5; index += 1) {
      await bot.handle(update(`/watch 0x${String(index).padStart(40, "0")}`));
    }
    await bot.handle(update(`/watch 0x${"6".padStart(40, "0")}`));
    expect(messages.at(-1)).toContain("limit reached");
    await bot.handle(update(`/unwatch ${address}`));
    expect(await store.getSubscriptions("12345")).toHaveLength(4);
  });

  it("parses deep links, validates thresholds, and confirms /stop deletion", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    const bot = new BotCommands({
      store,
      send: async (_chat, text) => { messages.push(text); },
      getHealth: async () => fakeHealth(),
    });

    await bot.handle(update(`/start w_${address.slice(2)}`));
    expect((await store.getSubscriptions("12345"))[0]?.address).toBe(address);
    await bot.handle(update("/setwarn 89"));
    expect(messages.at(-1)).toContain("warn < danger");
    await bot.handle(update("/setdanger 85"));
    expect((await store.getSettings("12345")).dangerLtv).toBe(85);
    await store.setLevel("12345", address, { level: "WARNING", troveActive: true, health: fakeHealth() });
    const sentKey = `0x${"a".repeat(64)}:0:12345`;
    await store.markSent(sentKey);
    await bot.handle(update("/stop"));
    expect((await store.getSubscriptions("12345")).length).toBe(1);
    await bot.handle(update("/stop confirm"));
    expect(await store.listChats()).toEqual([]);
    expect(await store.getLevel("12345", address)).toBeUndefined();
    expect(await store.markSent(sentKey)).toBe(true);
    expect(messages.at(-1)).toContain("deleted");
  });

  it("estimates LTV at a supplied BTC price", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    await store.addSubscription("12345", { address }, limits);
    const bot = new BotCommands({
      store,
      send: async (_chat, text) => { messages.push(text); },
      getHealth: async () => fakeHealth(),
    });

    await bot.handle(update(`/whatif 50000 ${address}`));

    expect(messages[0]).toContain("At BTC price $50000.00:");
    expect(messages[0]).toContain("LTV:");
    expect(messages[0]).toContain("Distance to liquidation:");
  });

  it("accepts a watched address with no active trove", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    const bot = new BotCommands({
      store,
      send: async (_chat, text) => { messages.push(text); },
      getHealth: async () => ({ ...fakeHealth(), troveActive: false }),
    });
    await bot.handle(update(`/watch ${address}`));
    expect(messages[0]).toContain("No active trove was found");
    expect(await store.getSubscriptions("12345")).toHaveLength(1);
  });

  it("ignores non-private chats and bot senders", async () => {
    const messages: string[] = [];
    const bot = new BotCommands({ store: new MemoryStore(), send: async (_chat, text) => { messages.push(text); } });
    await bot.handle({ ...update("/help"), chatType: "group" });
    await bot.handle({ ...update("/help"), senderIsBot: true });
    expect(messages).toEqual([]);
  });

  it("limits unknown-command hints to one per minute per chat", async () => {
    const messages: string[] = [];
    const bot = new BotCommands({ store: new MemoryStore(), send: async (_chat, text) => { messages.push(text); } });
    await bot.handle(update("/unknown"));
    await bot.handle(update("/unknown"));
    expect(messages).toEqual(["Unknown command. Try /help."]);
  });

  it("validates ordered four-level thresholds and alert settings", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    const bot = new BotCommands({ store, send: async (_chat, text) => { messages.push(text); } });
    await bot.handle(update("/setmonitor 60"));
    expect((await store.getSettings("12345")).monitorLtv).toBe(60);
    await bot.handle(update("/setwarn 59"));
    expect(messages.at(-1)).toContain("monitor < warn < danger");
    await bot.handle(update("/monitoralerts on"));
    await bot.handle(update("/pricealerts off"));
    await bot.handle(update("/setdrop 12"));
    await bot.handle(update("/reminders off"));
    const settings = await store.getSettings("12345");
    expect(settings.monitorAlerts).toBe(true);
    expect(settings.priceAlerts).toBe(false);
    expect(settings.dropPercent).toBe(12);
    expect(settings.reminders).toBe(false);
    await bot.handle(update("/settings"));
    expect(messages.at(-1)).toContain("Monitor LTV: 60%");
    expect(messages.at(-1)).toContain("Price drop: 12%");
  });

  it("shows a colored icon and level word with buffer values", () => {
    const text = formatHealth(fakeHealth(), { monitorLtv: 55, warnLtv: 70, dangerLtv: 80 });
    expect(text).toContain("🟠 WARNING");
    expect(text).toContain("BTC price at WARNING (70%)");
    expect(text).toContain("BTC can fall");
    expect(formatHealth({ ...fakeHealth(), troveActive: false }, {
      monitorLtv: 55, warnLtv: 70, dangerLtv: 80,
    })).toContain("⚪ NO_LOAN");
  });

  it("does not echo markup-like user labels in messages", async () => {
    const messages: string[] = [];
    const bot = new BotCommands({
      store: new MemoryStore(),
      send: async (_chat, text) => { messages.push(text); },
      getHealth: async () => fakeHealth(),
    });
    await bot.handle(update(`/watch ${address} <b>bad</b>`));
    expect(messages.join("\n")).not.toContain("<b>");
    expect(messages.join("\n")).toContain("Label must contain only");
  });

  it("validates callbacks, answers malformed/unwatched callbacks, and avoids double-extending snooze", async () => {
    const store = new MemoryStore();
    const answers: string[] = [];
    const messages: string[] = [];
    await store.addSubscription("12345", { address }, limits);
    await store.setLevel("12345", address, { level: "WARNING", troveActive: true });
    const bot = new BotCommands({
      store,
      send: async (_chat, text) => { messages.push(text); },
      getHealth: async () => fakeHealth(),
      answerCallback: async (_id, text) => { answers.push(text ?? ""); },
    });
    const callback = (id: string, data: string, callbackChatId = 12345): TelegramUpdate => ({
      updateId: 1,
      callbackQueryId: id,
      callbackData: data,
      callbackChatId,
      callbackChatType: "private",
      callbackSenderId: callbackChatId,
      callbackSenderIsBot: false,
    });
    await bot.handle(callback("bad", "not-a-button"));
    await bot.handle(callback("unwatched", `c:${"2".repeat(40)}`));
    expect(answers[0]).toBe("Invalid button.");
    expect(answers[1]).toContain("no longer on your watch list");
    expect(messages).toEqual([]);
    await bot.handle(callback("snooze-1", `s1:${address.slice(2)}`));
    const originalUntil = (await store.getLevel("12345", address))?.snoozedUntil;
    await bot.handle(callback("snooze-2", `s1:${address.slice(2)}`));
    expect((await store.getLevel("12345", address))?.snoozedUntil).toBe(originalUntil);
    expect(answers).toHaveLength(4);
  });

  it("starts a fresh snooze after expiry and persists a snooze across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "musd-guardian-snooze-"));
    const path = join(directory, "state.json");
    try {
      const store = await FileStore.open(path);
      await store.addSubscription("12345", { address }, limits);
      await store.setLevel("12345", address, {
        level: "WARNING", troveActive: true, snoozedUntil: Date.now() - 1, snoozeLevel: "WARNING",
      });
      await store.flush();
      const reopened = await FileStore.open(path);
      const answers: string[] = [];
      const bot = new BotCommands({
        store: reopened,
        send: async () => {},
        answerCallback: async (_id, text) => { answers.push(text ?? ""); },
      });
      await bot.handle({
        updateId: 2,
        callbackQueryId: "expired",
        callbackData: `s6:${address.slice(2)}`,
        callbackChatId: 12345,
        callbackChatType: "private",
        callbackSenderId: 12345,
        callbackSenderIsBot: false,
      });
      const saved = await FileStore.open(path);
      const state = await saved.getLevel("12345", address);
      expect(state?.snoozedUntil).toBeGreaterThan(Date.now());
      expect(state?.snoozeLevel).toBe("WARNING");
      expect(answers[0]).toContain("Snoozed until");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("health transitions", () => {
  it("uses a 3-point hysteresis for each chat's thresholds", () => {
    expect(transitionLevel(55, undefined, 55, 70, 80)).toBe("MONITOR");
    expect(transitionLevel(70, undefined, 55, 70, 80)).toBe("WARNING");
    expect(transitionLevel(80, undefined, 55, 70, 80)).toBe("DANGER");
    expect(transitionLevel(77, { level: "DANGER", troveActive: true }, 55, 70, 80)).toBe("DANGER");
    expect(transitionLevel(67, { level: "WARNING", troveActive: true }, 55, 70, 80)).toBe("WARNING");
    expect(transitionLevel(52, { level: "MONITOR", troveActive: true }, 55, 70, 80)).toBe("MONITOR");
    expect(transitionLevel(51, { level: "MONITOR", troveActive: true }, 55, 70, 80)).toBe("SAFE");
  });

  it("keeps last-good levels on stale data and sends the trove-closed message once", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    const send = async (_chat: string, text: string) => { messages.push(text); };
    await store.addSubscription(chatId, { address }, limits);
    await store.setLevel(chatId, address, { level: "WARNING", troveActive: true, health: fakeHealth() });
    await runHealthCycle(store, send, async () => { throw new Error("offline"); }, 20);
    expect((await store.getLevel(chatId, address))?.level).toBe("WARNING");
    expect(messages).toEqual([]);
    const inactive = { ...fakeHealth(), troveActive: false };
    await runHealthCycle(store, send, async () => inactive);
    await runHealthCycle(store, send, async () => inactive);
    expect(messages).toEqual([
      "This trove is no longer active (closed, repaid or liquidated). Check the explorer.",
    ]);
  });

  it("applies different settings per chat", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    await store.addSubscription("123450", { address }, { ...limits, maxAddressesPerChat: 2 });
    await store.addSubscription("123451", { address }, { ...limits, maxAddressesPerChat: 2 });
    await store.setSettings("123451", { ...(await store.getSettings("123451")), warnLtv: 78, dangerLtv: 89 });
    await store.setLevel("123450", address, { level: "SAFE", troveActive: true });
    await store.setLevel("123451", address, { level: "SAFE", troveActive: true });
    await runHealthCycle(store, async (chat, text) => { messages.push(`${chat}:${text}`); }, async () => ({
      ...fakeHealth(),
      ltvPercent: 75,
    }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("123450:WARNING");
  });

  it("keeps MONITOR informational unless that chat enables monitor alerts", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    await store.addSubscription(chatId, { address }, limits);
    await store.setLevel(chatId, address, { level: "SAFE", troveActive: true });
    await runHealthCycle(store, async (_chat, text) => { messages.push(text); }, async () => ({
      ...fakeHealth(), ltvPercent: 58,
    }));
    expect(messages).toEqual([]);
    expect((await store.getLevel(chatId, address))?.level).toBe("MONITOR");

    await store.setSettings(chatId, { ...(await store.getSettings(chatId)), monitorAlerts: true });
    await store.setLevel(chatId, address, { level: "SAFE", troveActive: true });
    await runHealthCycle(store, async (_chat, text) => { messages.push(text); }, async () => ({
      ...fakeHealth(), ltvPercent: 58,
    }));
    expect(messages[0]).toContain("MONITOR:");
  });

  it("sends a DANGER escalation despite an active lower-level snooze", async () => {
    const store = new MemoryStore();
    const messages: string[] = [];
    await store.addSubscription(chatId, { address }, limits);
    await store.setLevel(chatId, address, {
      level: "WARNING", troveActive: true, snoozedUntil: Date.now() + 60_000, snoozeLevel: "WARNING",
    });
    await runHealthCycle(store, async (_chat, text) => { messages.push(text); }, async () => ({
      ...fakeHealth(), ltvPercent: 85,
    }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("DANGER");
  });

  it("repeats DANGER on cadence and stops after REMIND_MAX", async () => {
    const oldMinutes = process.env.REMIND_DANGER_MINUTES;
    const oldMax = process.env.REMIND_MAX;
    process.env.REMIND_DANGER_MINUTES = "60";
    process.env.REMIND_MAX = "2";
    try {
      const store = new MemoryStore();
      const messages: string[] = [];
      await store.addSubscription(chatId, { address }, limits);
      await store.setLevel(chatId, address, {
        level: "DANGER", troveActive: true, health: { ...fakeHealth(), ltvPercent: 85 },
        reminderCount: 0, lastReminderAt: Date.now() - 3_700_000,
      });
      await runHealthCycle(store, async (_chat, text) => { messages.push(text); }, async () => ({
        ...fakeHealth(), ltvPercent: 85,
      }));
      expect(messages).toHaveLength(1);
      expect((await store.getLevel(chatId, address))?.reminderCount).toBe(1);
      await store.setLevel(chatId, address, {
        ...(await store.getLevel(chatId, address))!,
        reminderCount: 0,
        lastReminderAt: Date.now() - 3_700_000,
        snoozedUntil: Date.now() + 60_000,
        snoozeLevel: "DANGER",
      });
      await runHealthCycle(store, async (_chat, text) => { messages.push(text); }, async () => ({
        ...fakeHealth(), ltvPercent: 85,
      }));
      expect(messages).toHaveLength(1);
      await store.setLevel(chatId, address, {
        ...(await store.getLevel(chatId, address))!,
        reminderCount: 0,
        lastReminderAt: Date.now() - 3_700_000,
        snoozedUntil: Date.now() - 1,
      });
      await runHealthCycle(store, async (_chat, text) => { messages.push(text); }, async () => ({
        ...fakeHealth(), ltvPercent: 85,
      }));
      expect(messages).toHaveLength(2);
      await store.setLevel(chatId, address, {
        ...(await store.getLevel(chatId, address))!,
        reminderCount: 2,
        lastReminderAt: Date.now() - 3_700_000,
      });
      await runHealthCycle(store, async (_chat, text) => { messages.push(text); }, async () => ({
        ...fakeHealth(), ltvPercent: 85,
      }));
      expect(messages).toHaveLength(2);
    } finally {
      if (oldMinutes === undefined) delete process.env.REMIND_DANGER_MINUTES;
      else process.env.REMIND_DANGER_MINUTES = oldMinutes;
      if (oldMax === undefined) delete process.env.REMIND_MAX;
      else process.env.REMIND_MAX = oldMax;
    }
  });

  it("limits simultaneous address reads to four", async () => {
    const store = new MemoryStore();
    for (let index = 1; index <= 5; index += 1) {
      await store.addSubscription(
        String(1000 + index),
        { address: `0x${String(index).padStart(40, "0")}` as Address },
        { maxAddressesPerChat: 1, maxChats: 10, maxTotalAddresses: 10 },
      );
    }
    let active = 0;
    let peak = 0;
    await runHealthCycle(store, async () => {}, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return fakeHealth();
    });
    expect(peak).toBe(4);
  });
});

describe("price alerts", () => {
      it("detects drops only within the rolling 60-minute window", () => {
        const now = 5_000_000;
        expect(detectPriceDrop([
          { t: now - 60 * 60_000 - 1, price: 100 },
          { t: now, price: 90 },
        ], now)).toBeUndefined();
        expect(detectPriceDrop([
          { t: now - 50 * 60_000, price: 100 },
          { t: now, price: 90 },
        ], now)?.percent).toBe(10);
      });

      it("alerts once per chat with before/after LTV, skips inactive troves, and persists cooldown", async () => {
        const store = new MemoryStore();
        const secondChat = "987654320";
        const messages: string[] = [];
        const now = Date.now();
        await store.addSubscription(chatId, { address }, limits);
        await store.addSubscription(secondChat, { address: "0x0000000000000000000000000000000000000002" as Address }, limits);
        await store.setLevel(chatId, address, { level: "WARNING", troveActive: true, health: fakeHealth() });
        await store.setLevel(secondChat, "0x0000000000000000000000000000000000000002" as Address, {
          level: "SAFE", troveActive: false, health: { ...fakeHealth(), troveActive: false },
        });
        await store.appendPriceSample({ t: now - 5 * 60_000, price: 100_000 }, 300);
        await store.appendPriceSample({ t: now, price: 94_000 }, 300);
        await processPriceDropAlerts(store, async (_chat, text) => { messages.push(text); }, [address], now);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("$100000.0 to $94000.0");
        expect(messages[0]).toContain("LTV before 75.0%; after 79.8%");
        expect(await store.getPriceAlertAt(chatId)).toBe(now);
        await processPriceDropAlerts(store, async (_chat, text) => { messages.push(text); }, [address], now + 60_000);
        expect(messages).toHaveLength(1);
      });

      it("sends no price alert without a fresh active address", async () => {
        const store = new MemoryStore();
        await store.addSubscription(chatId, { address }, limits);
        const now = Date.now();
        await store.appendPriceSample({ t: now - 60_000, price: 100_000 }, 300);
        await store.appendPriceSample({ t: now, price: 90_000 }, 300);
        const messages: string[] = [];
        await processPriceDropAlerts(store, async (_chat, text) => { messages.push(text); }, [address], now);
        await processPriceDropAlerts(store, async (_chat, text) => { messages.push(text); }, [], now);
        expect(messages).toEqual([]);
      });

      it("skips a stale oracle sample", async () => {
        const originalMaxAge = process.env.PRICE_MAX_AGE_SECONDS;
        process.env.PRICE_MAX_AGE_SECONDS = "10";
        try {
          const store = new MemoryStore();
          await store.addSubscription(chatId, { address }, limits);
          await store.setLevel(chatId, address, { level: "WARNING", troveActive: true, health: fakeHealth() });
          const now = Date.now();
          await store.appendPriceSample({ t: now - 60_000, price: 100_000 }, 300);
          await store.appendPriceSample({ t: now - 30_000, price: 90_000 }, 300);
          const messages: string[] = [];
          await processPriceDropAlerts(store, async (_chat, text) => { messages.push(text); }, [address], now);
          expect(messages).toEqual([]);
        } finally {
          if (originalMaxAge === undefined) delete process.env.PRICE_MAX_AGE_SECONDS;
          else process.env.PRICE_MAX_AGE_SECONDS = originalMaxAge;
        }
      });

      it("creates compact callback actions and safe URL buttons", () => {
        const markup = alertKeyboard(address);
        const callbacks = markup.inline_keyboard.flat().flatMap((button) => button.callback_data ?? []);
        expect(callbacks).toEqual([`c:${address.slice(2)}`, `s1:${address.slice(2)}`, `s6:${address.slice(2)}`]);
        expect(callbacks.every((data) => data.length < 64)).toBe(true);
        expect(markup.inline_keyboard.flat().map((button) => button.url).filter(Boolean)).toEqual([
          "https://testnet.mezo.org/borrow",
          `https://explorer.test.mezo.org/address/${address}`,
        ]);
      });
});

describe("MUSD transfer processing", () => {
  it("matches tracked addresses in a range and deduplicates per chat", async () => {
    const store = new MemoryStore();
    await store.addSubscription(chatId, { address }, limits);
    const sender = "0x0000000000000000000000000000000000000002" as Address;
    const topics = encodeEventTopics({
      abi: musdAbi,
      eventName: "Transfer",
      args: { from: sender, to: address as Address },
    });
    const txHash = `0x${"b".repeat(64)}` as const;
    const log: Log = {
      address: MUSD_ADDRESS,
      topics,
      data: encodeAbiParameters(parseAbiParameters("uint256"), [100n]),
      blockNumber: 10n,
      blockHash: `0x${"c".repeat(64)}`,
      transactionHash: txHash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    };
    const messages: string[] = [];
    let requests = 0;
    const readLogs = async () => {
      requests += 1;
      return [log];
    };
    const send = async (_chat: string, text: string) => { messages.push(text); };
    await processTransferRange(store, send, 1n, 10n, readLogs);
    await processTransferRange(store, send, 1n, 10n, readLogs);
    expect(requests).toBe(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("IN");
    expect(await store.getLastProcessedBlock()).toBe(10n);
  });
});

describe("rate limits and outbound delivery", () => {
  it("enforces 20 command tokens per minute and 10 watches per hour", () => {
    const limiter = new CommandRateLimiter();
    let now = 1000;
    for (let index = 0; index < 10; index += 1) expect(limiter.allow("chat", "/watch", now)).toBe(true);
    expect(limiter.allow("chat", "/watch", now)).toBe(false);
    expect(limiter.allow("other", "/help", now)).toBe(true);
    for (let index = 0; index < 10; index += 1) expect(limiter.allow("chat", "/help", now)).toBe(true);
    expect(limiter.allow("chat", "/help", now)).toBe(false);
    now += 60_000;
    expect(limiter.allow("chat", "/help", now)).toBe(true);
  });

  it("spaces outbound messages to the same chat by about one second", async () => {
    const times: number[] = [];
    const queue = new OutboundQueue(async () => { times.push(Date.now()); }, async () => {});
    await Promise.all([queue.sendMessage("chat", "one"), queue.sendMessage("chat", "two")]);
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
  });

  it("honors Telegram retry_after and removes a chat when blocked", async () => {
    let attempts = 0;
    const queue = new OutboundQueue(async () => {
      attempts += 1;
      if (attempts === 1) throw new TelegramApiError("rate limited", 429, 1);
    }, async () => {});
    await queue.sendMessage("987654321", "test");
    expect(attempts).toBe(2);

    let removed: string | undefined;
    const blockedQueue = new OutboundQueue(
      async () => { throw new TelegramApiError("chat unavailable", 403, undefined, true); },
      async (chat) => { removed = chat; },
    );
    await blockedQueue.sendMessage("987654321", "test");
    expect(removed).toBe("987654321");
  });
});

function fakeHealth(): LoanHealth {
  return {
    collateralBtc: 1,
    debtMusd: 75_000,
    btcPriceUsd: 100_000,
    collateralValueUsd: 100_000,
    ltvPercent: 75,
    liquidationLtvPercent: 90,
    distanceToLiquidationPercent: 15,
    troveActive: true,
    rawValues: {
      collateral: "1",
      debt: "75000",
      btcPrice: "100000",
      decimalPrecision: "1",
      troveStatus: 1,
      musdDecimals: 18,
      collateralDecimals: 18,
      priceDecimals: 0,
    },
  };
}
