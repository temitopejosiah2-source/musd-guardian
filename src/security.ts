const MAX_LOG_LENGTH = 1000;

export function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  const rpcUrl = process.env.RPC_URL;
  const secrets = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID,
    process.env.TELEGRAM_ALLOWED_USER_IDS,
    rpcUrl,
  ].filter((secret): secret is string => Boolean(secret?.trim()));

  for (const secret of secrets) {
    text = text.replaceAll(secret, "[redacted]");
  }
  if (rpcUrl) {
    try {
      const endpoint = new URL(rpcUrl);
      const endpointPrefix = `${endpoint.origin}${endpoint.pathname}`;
      let position = text.indexOf(endpointPrefix);
      while (position !== -1) {
        let end = position + endpointPrefix.length;
        while (end < text.length && !/[\s"'<>]/.test(text.charAt(end))) end += 1;
        text = `${text.slice(0, position)}[RPC endpoint]${text.slice(end)}`;
        position = text.indexOf(endpointPrefix, position + "[RPC endpoint]".length);
      }
    } catch {
      // Environment validation reports malformed endpoints without logging their values.
    }
  }

  return text
    .replace(/\b(bot)[0-9]{5,}:[A-Za-z0-9_-]{20,}\b/gi, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:key|token|api[_-]?key|secret|password)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, MAX_LOG_LENGTH);
}

export function logInfo(message: unknown): void {
  console.log(redact(message));
}

export function logError(message: unknown): void {
  console.error(redact(message));
}

export function logWarn(message: unknown): void {
  console.warn(redact(message));
}

export function authorizeTelegramCommand(
  message: { chatId?: number; senderId?: number; text?: string },
  targetChatId: string,
  allowedSenderIds: readonly string[],
): boolean {
  return (
    message.chatId !== undefined &&
    String(message.chatId) === targetChatId &&
    message.senderId !== undefined &&
    allowedSenderIds.includes(String(message.senderId)) &&
    typeof message.text === "string" &&
    message.text.length > 0 &&
    message.text.length <= 512
  );
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}

export async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response exceeded the allowed size");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeded the allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(content);
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  return JSON.parse(await readBoundedText(response, maxBytes)) as unknown;
}
