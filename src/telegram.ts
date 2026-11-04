import { fetchWithTimeout, readBoundedJson } from "./security.js";
import { getTimeoutMs } from "./config.js";

export interface TelegramUpdate {
  updateId: number;
  chatId?: number;
  chatType?: string;
  senderId?: number;
  senderIsBot?: boolean;
  text?: string;
  callbackQueryId?: string;
  callbackChatId?: number;
  callbackChatType?: string;
  callbackSenderId?: number;
  callbackSenderIsBot?: boolean;
  callbackData?: string;
}

export async function processTelegramUpdates(
  updates: TelegramUpdate[],
  offset: number | undefined,
  handle: (update: TelegramUpdate) => Promise<void>,
  saveOffset: (nextOffset: number) => Promise<void>,
  onOffsetSaved?: (nextOffset: number) => void,
): Promise<number | undefined> {
  let nextOffset = offset;
  for (const update of updates) {
    await handle(update);
    nextOffset = update.updateId + 1;
    await saveOffset(nextOffset);
    onOffsetSaved?.(nextOffset);
  }
  return nextOffset;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{
    text: string;
    callback_data?: string;
    url?: string;
  }>>;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfterSeconds?: number,
    readonly chatUnavailable = false,
  ) {
    super(message);
  }
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  if (text.length > 4096) throw new Error("Telegram message exceeded the allowed size");
  const response = await telegramFetch(token, "sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!response.ok) {
    const body = await readBoundedJson(response, 64 * 1024).catch(() => undefined);
    throw telegramApiError("Telegram sendMessage failed", response.status, body);
  }
  const result: unknown = await readBoundedJson(response, 64 * 1024);
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true
  ) {
    throw telegramApiError("Telegram sendMessage returned an unsuccessful response", undefined, result);
  }
}

export async function getTelegramUpdates(
  token: string,
  offset: number | undefined,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const requestTimeoutMs = getTimeoutMs("TELEGRAM_TIMEOUT_MS");
  const longPollSeconds = Math.min(25, Math.floor((requestTimeoutMs - 1_000) / 1_000));
  const query = new URLSearchParams({ timeout: String(longPollSeconds), allowed_updates: '["message","callback_query"]' });
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
        "chat" in item.message &&
        typeof item.message.chat === "object" &&
        item.message.chat !== null &&
        "type" in item.message.chat &&
        typeof item.message.chat.type === "string"
      ) update.chatType = item.message.chat.type;
      if (
        "from" in item.message &&
        typeof item.message.from === "object" &&
        item.message.from !== null &&
        "id" in item.message.from &&
        typeof item.message.from.id === "number"
      ) {
        update.senderId = item.message.from.id;
      }
      if (
        "from" in item.message &&
        typeof item.message.from === "object" &&
        item.message.from !== null &&
        "is_bot" in item.message.from &&
        typeof item.message.from.is_bot === "boolean"
      ) update.senderIsBot = item.message.from.is_bot;
      if ("text" in item.message && typeof item.message.text === "string") {
        update.text = item.message.text;
      }
    }
    if ("callback_query" in item && typeof item.callback_query === "object" && item.callback_query !== null) {
      const callback = item.callback_query;
      if ("id" in callback && typeof callback.id === "string") update.callbackQueryId = callback.id;
      if ("data" in callback && typeof callback.data === "string") update.callbackData = callback.data;
      if ("from" in callback && typeof callback.from === "object" && callback.from !== null &&
        "id" in callback.from && typeof callback.from.id === "number") {
        update.callbackSenderId = callback.from.id;
      }
      if ("from" in callback && typeof callback.from === "object" && callback.from !== null &&
        "is_bot" in callback.from && typeof callback.from.is_bot === "boolean") {
        update.callbackSenderIsBot = callback.from.is_bot;
      }
      if ("message" in callback && typeof callback.message === "object" && callback.message !== null &&
        "chat" in callback.message && typeof callback.message.chat === "object" && callback.message.chat !== null) {
        const chat = callback.message.chat;
        if ("id" in chat && typeof chat.id === "number") update.callbackChatId = chat.id;
        if ("type" in chat && typeof chat.type === "string") update.callbackChatType = chat.type;
      }
    }
    return [update];
  });
}

export async function answerTelegramCallback(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const response = await telegramFetch(token, "answerCallbackQuery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
  });
  if (!response.ok) throw new Error(`Telegram answerCallbackQuery returned HTTP ${response.status}`);
  const result: unknown = await readBoundedJson(response, 64 * 1024);
  if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) {
    throw telegramApiError("Telegram answerCallbackQuery failed", undefined, result);
  }
}

async function telegramFetch(
  token: string,
  method: string,
  options: RequestInit,
): Promise<Response> {
  const timeoutMs = getTimeoutMs("TELEGRAM_TIMEOUT_MS");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
      ...options,
      signal,
    }, timeoutMs);
  } catch {
    throw new TelegramApiError("Telegram request failed");
  }
}

function telegramApiError(label: string, status: number | undefined, payload: unknown): TelegramApiError {
  let errorCode = status;
  let retryAfterSeconds: number | undefined;
  let description = "";
  if (typeof payload === "object" && payload !== null) {
    if ("error_code" in payload && typeof payload.error_code === "number") errorCode = payload.error_code;
    if ("description" in payload && typeof payload.description === "string") description = payload.description;
    if (
      "parameters" in payload && typeof payload.parameters === "object" && payload.parameters !== null &&
      "retry_after" in payload.parameters && typeof payload.parameters.retry_after === "number"
    ) retryAfterSeconds = payload.parameters.retry_after;
  }
  const chatUnavailable = /blocked|chat not found|kicked/i.test(description);
  const reason = chatUnavailable
    ? "chat unavailable"
    : status === 429 || errorCode === 429
      ? "rate limited"
      : "request failed";
  return new TelegramApiError(`${label}: ${reason}`, errorCode, retryAfterSeconds, chatUnavailable);
}
