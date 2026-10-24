import { fetchWithTimeout, readBoundedJson } from "./security.js";

export interface TelegramUpdate {
  updateId: number;
  chatId?: number;
  senderId?: number;
  text?: string;
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  if (text.length > 4096) throw new Error("Telegram message exceeded the allowed size");
  const response = await telegramFetch(token, "sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage returned HTTP ${response.status}`);
  }
  const result: unknown = await readBoundedJson(response, 64 * 1024);
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true
  ) {
    throw new Error("Telegram sendMessage returned an unsuccessful response");
  }
}

export async function getTelegramUpdates(
  token: string,
  offset: number | undefined,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const query = new URLSearchParams({ timeout: "25", allowed_updates: '["message"]' });
  if (offset !== undefined) query.set("offset", String(offset));
  const response = await telegramFetch(token, `getUpdates?${query}`, { signal });
  if (!response.ok) {
    throw new Error(`Telegram getUpdates returned HTTP ${response.status}`);
  }
  const payload: unknown = await readBoundedJson(response, 1024 * 1024);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("ok" in payload) ||
    payload.ok !== true ||
    !("result" in payload) ||
    !Array.isArray(payload.result)
  ) {
    throw new Error("Telegram getUpdates returned an unsuccessful response");
  }

  return payload.result.flatMap((item: unknown): TelegramUpdate[] => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("update_id" in item) ||
      typeof item.update_id !== "number" ||
      !Number.isInteger(item.update_id)
    ) {
      return [];
    }
    const update: TelegramUpdate = { updateId: item.update_id };
    if ("message" in item && typeof item.message === "object" && item.message !== null) {
      if (
        "chat" in item.message &&
        typeof item.message.chat === "object" &&
        item.message.chat !== null &&
        "id" in item.message.chat &&
        typeof item.message.chat.id === "number"
      ) {
        update.chatId = item.message.chat.id;
      }
      if (
        "from" in item.message &&
        typeof item.message.from === "object" &&
        item.message.from !== null &&
        "id" in item.message.from &&
        typeof item.message.from.id === "number"
      ) {
        update.senderId = item.message.from.id;
      }
      if ("text" in item.message && typeof item.message.text === "string") {
        update.text = item.message.text;
      }
    }
    return [update];
  });
}

async function telegramFetch(
  token: string,
  method: string,
  options: RequestInit,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(35_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
      ...options,
      signal,
    }, 35_000);
  } catch {
    throw new Error("Telegram request failed");
  }
}
