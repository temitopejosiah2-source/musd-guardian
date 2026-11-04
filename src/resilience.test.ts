import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExponentialBackoff,
  retryLockRenewal,
  ServiceStatusTracker,
  stopIfLockLost,
} from "./resilience.js";
import { processTelegramUpdates, type TelegramUpdate } from "./telegram.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("resilience helpers", () => {
  it("retries lock renewal twice and keeps the lock after success", async () => {
    let attempts = 0;
    const result = await retryLockRenewal(async () => {
      attempts += 1;
      return attempts < 3 ? "unavailable" : "renewed";
    }, {
      lastSuccessAt: 0,
      now: () => 0,
      wait: async () => {},
    });
    expect(result).toBe("renewed");
    expect(attempts).toBe(3);
  });

  it("marks the lock lost after renewal failures pass the safe TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let attempts = 0;
    const result = await retryLockRenewal(async () => {
      attempts += 1;
      return "unavailable";
    }, {
      lastSuccessAt: 0,
      now: () => Date.now(),
      wait: async (milliseconds) => {
        await vi.advanceTimersByTimeAsync(Math.max(400, milliseconds));
      },
      ttlMs: 1000,
      safetyMarginMs: 200,
      timeoutMs: 100,
    });
    expect(result).toBe("lost");
    expect(attempts).toBe(2);
    let exitCode = 0;
    let stopped = false;
    expect(stopIfLockLost(result, () => { stopped = true; }, (code) => { exitCode = code; })).toBe(true);
    expect(exitCode).toBe(1);
    expect(stopped).toBe(true);
  });

  it("detects when another instance owns the lock", async () => {
    const result = await retryLockRenewal(async () => "lost", { lastSuccessAt: 0 });
    expect(result).toBe("lost");
  });

  it("resets exponential backoff after success", () => {
    const backoff = new ExponentialBackoff(1000, 60_000, 0);
    expect(backoff.nextDelay(() => 0.5)).toBe(1000);
    expect(backoff.nextDelay(() => 0.5)).toBe(2000);
    backoff.reset();
    expect(backoff.nextDelay(() => 0.5)).toBe(1000);
  });

  it("logs an outage only once and reports its duration on recovery", () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const status = new ServiceStatusTracker((line) => starts.push(line), (line) => ends.push(line));
    status.failed("rpc", 1000);
    status.failed("rpc", 2000);
    status.succeeded("rpc", 6500);
    expect(starts).toEqual(["network trouble: rpc (outage started)"]);
    expect(ends).toEqual(["network trouble ended: rpc after 5s (outage ended)"]);
    expect(status.snapshot().rpc.lastSuccessAt).toBe(new Date(6500).toISOString());
  });
});

describe("Telegram update acknowledgement", () => {
  it("recovers from a getUpdates outage without skipping fetched updates", async () => {
    let attempts = 0;
    let offset: number | undefined = 20;
    const handled: number[] = [];
    const saved: number[] = [];
    const fakeGetUpdates = async (): Promise<TelegramUpdate[]> => {
      attempts += 1;
      if (attempts === 1) throw new Error("network timeout");
      return [{ updateId: 20 }, { updateId: 21 }];
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const updates = await fakeGetUpdates();
        offset = await processTelegramUpdates(updates, offset, async (update) => {
          handled.push(update.updateId);
        }, async (nextOffset) => { saved.push(nextOffset); });
      } catch {
        continue;
      }
    }
    expect(attempts).toBe(2);
    expect(handled).toEqual([20, 21]);
    expect(saved).toEqual([21, 22]);
    expect(offset).toBe(22);
  });

  it("advances the offset only after each update has been handled", async () => {
    const updates: TelegramUpdate[] = [{ updateId: 10 }, { updateId: 11 }];
    const handled: number[] = [];
    const saved: number[] = [];
    let offset: number | undefined = 10;
    await expect(processTelegramUpdates(updates, 10, async (update) => {
      if (update.updateId === 11) throw new Error("temporary handler failure");
      handled.push(update.updateId);
    }, async (nextOffset) => { saved.push(nextOffset); }, (nextOffset) => { offset = nextOffset; }))
      .rejects.toThrow("temporary handler failure");
    expect(handled).toEqual([10]);
    expect(saved).toEqual([11]);
    expect(offset).toBe(11);

    await processTelegramUpdates(updates.slice(1), 11, async (update) => {
      handled.push(update.updateId);
    }, async (offset) => { saved.push(offset); });
    expect(handled).toEqual([10, 11]);
    expect(saved).toEqual([11, 12]);
  });
});

it("keeps a failed outbound message queued until delivery recovers", async () => {
  const { OutboundQueue } = await import("./outbound.js");
  const { TelegramApiError } = await import("./telegram.js");
  let attempts = 0;
  const delivered: string[] = [];
  const queue = new OutboundQueue(async (_chatId, text) => {
    attempts += 1;
    if (attempts === 1) throw new TelegramApiError("Telegram request failed");
    delivered.push(text);
  }, async () => {}, { wait: async () => {} });
  await queue.sendMessage("123", "one alert");
  expect(attempts).toBe(2);
  expect(delivered).toEqual(["one alert"]);
});

it("does not advance transfer progress or duplicate alerts after a send timeout", async () => {
  const { MemoryStore } = await import("./store/memory.js");
  const { processTransferRange } = await import("./monitor.js");
  const viem = await import("viem");
  const { MUSD_ADDRESS } = await import("./config.js");
  const { musdAbi } = await import("./musd.js");
  const store = new MemoryStore();
  const chatId = "987654321";
  const address = "0x0000000000000000000000000000000000000001" as viem.Address;
  await store.addSubscription(chatId, { address }, {
    maxAddressesPerChat: 5,
    maxChats: 150,
    maxTotalAddresses: 300,
  });
  const topics = viem.encodeEventTopics({
    abi: musdAbi,
    eventName: "Transfer",
    args: {
      from: "0x0000000000000000000000000000000000000002",
      to: address,
    },
  });
  const log: viem.Log = {
    address: MUSD_ADDRESS,
    topics,
    data: viem.encodeAbiParameters(viem.parseAbiParameters("uint256"), [100n]),
    blockNumber: 5n,
    blockHash: `0x${"c".repeat(64)}`,
    transactionHash: `0x${"b".repeat(64)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
  let attempts = 0;
  const delivered: string[] = [];
  const send = async (_chat: string, message: string) => {
    attempts += 1;
    if (attempts === 1) throw new Error("network timeout");
    delivered.push(message);
  };
  await expect(processTransferRange(store, send, 1n, 5n, async () => [log])).rejects.toThrow("network timeout");
  expect(await store.getLastProcessedBlock()).toBeUndefined();
  await processTransferRange(store, send, 1n, 5n, async () => [log]);
  expect(await store.getLastProcessedBlock()).toBe(5n);
  expect(attempts).toBe(2);
  expect(delivered).toHaveLength(1);
});
