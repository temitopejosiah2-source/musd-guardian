import { TelegramApiError, type InlineKeyboardMarkup } from "./telegram.js";
import { ExponentialBackoff } from "./resilience.js";

export class OutboundQueue {
  private readonly chatNext = new Map<string, number>();
  private globalNext = 0;
  private chain = Promise.resolve();
  private stopped = false;
  private resolveStopped!: () => void;
  private readonly stoppedPromise = new Promise<void>((resolve) => { this.resolveStopped = resolve; });

  constructor(
    private readonly send: (chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup) => Promise<void>,
    private readonly onUnavailable: (chatId: string) => Promise<void>,
    private readonly options: {
      onFailure?: (error: unknown) => void;
      onSuccess?: () => void;
      wait?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {}

  sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
    const operation = this.chain.then(() => this.deliver(chatId, text, replyMarkup));
    this.chain = operation.catch(() => {});
    return operation;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  stop(): void {
    this.stopped = true;
    this.resolveStopped();
  }

  private async deliver(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
    if (this.stopped) throw new Error("Outbound delivery stopped before success");
    const backoff = new ExponentialBackoff();
    while (!this.stopped) {
      await this.waitForSlot(chatId);
      if (this.stopped) throw new Error("Outbound delivery stopped before success");
      try {
        await this.send(chatId, text, replyMarkup);
        this.options.onSuccess?.();
        return;
      } catch (error) {
        if (!(error instanceof TelegramApiError)) throw error;
        if (
          (error.errorCode === 403 || error.chatUnavailable)
        ) {
          await this.onUnavailable(chatId);
          return;
        }
        if (error.errorCode !== 429 &&
          error.errorCode !== undefined && error.errorCode < 500) {
          throw error;
        }
        this.options.onFailure?.(error);
        const retryAfter = error.retryAfterSeconds;
        await this.wait(
          retryAfter ? Math.max(1, retryAfter) * 1000 : backoff.nextDelay(),
        );
      }
    }
    throw new Error("Outbound delivery stopped before success");
  }

  private async waitForSlot(chatId: string): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const at = Math.max(now, this.globalNext, this.chatNext.get(chatId) ?? 0);
    if (at > now) await this.wait(at - now);
    if (this.stopped) return;
    const sentAt = Date.now();
    this.globalNext = sentAt + 40;
    this.chatNext.set(chatId, sentAt + 1000);
  }

  private async wait(milliseconds: number): Promise<void> {
    await Promise.race([
      this.options.wait ? this.options.wait(milliseconds) : delay(milliseconds),
      this.stoppedPromise,
    ]);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
