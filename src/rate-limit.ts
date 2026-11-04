export class CommandRateLimiter {
  private readonly commandTokens = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly watchAttempts = new Map<string, number[]>();

  allow(chatId: string, command: string, now = Date.now()): boolean {
    const bucket = this.commandTokens.get(chatId) ?? { tokens: 20, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(20, bucket.tokens + elapsed * (20 / 60_000));
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.commandTokens.set(chatId, bucket);
      return false;
    }
    if (command === "/watch") {
      const recent = (this.watchAttempts.get(chatId) ?? []).filter((time) => now - time < 3_600_000);
      if (recent.length >= 10) {
        this.watchAttempts.set(chatId, recent);
        this.commandTokens.set(chatId, bucket);
        return false;
      }
      recent.push(now);
      this.watchAttempts.set(chatId, recent);
    }
    bucket.tokens -= 1;
    this.commandTokens.set(chatId, bucket);
    return true;
  }
}
