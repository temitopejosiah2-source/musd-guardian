import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import {
  authorizeTelegramCommand,
  redact,
  registerChatId,
} from "./security.js";

const original = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  rpcUrl: process.env.RPC_URL,
};
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token-value";
process.env.TELEGRAM_CHAT_ID = "-123456789";
process.env.RPC_URL = "https://user:password@example.invalid/rpc";

afterAll(() => {
  restore("TELEGRAM_BOT_TOKEN", original.token);
  restore("TELEGRAM_CHAT_ID", original.chatId);
  restore("RPC_URL", original.rpcUrl);
});

test("redacts Telegram credentials and RPC endpoint credentials", () => {
  const output = redact(
    `token=${process.env.TELEGRAM_BOT_TOKEN} chat=${process.env.TELEGRAM_CHAT_ID} rpc=${process.env.RPC_URL}/extra`,
  );
  assert.equal(output.includes("test-bot-token-value"), false);
  assert.equal(output.includes("-123456789"), false);
  assert.equal(output.includes("user:password"), false);
  assert.equal(output.includes("example.invalid"), false);
  assert.match(output, /\[redacted\]/);
});

test("redacts HTTPS RPC endpoint credentials and keys", () => {
  const originalRpcUrl = process.env.RPC_URL;
  process.env.RPC_URL = "https://rpc.example.invalid/endpoint?key=rpc-secret-value";
  try {
    const output = redact(`Request failed for ${process.env.RPC_URL}`);
    assert.equal(output.includes("rpc.example.invalid"), false);
    assert.equal(output.includes("rpc-secret-value"), false);
  } finally {
    restore("RPC_URL", originalRpcUrl);
  }
});

test("redacts registered chat ids without redacting health values", () => {
  registerChatId("987654321");
  const output = redact("chat=987654321; debt=100000 MUSD; btc price=$9876543210");
  assert.equal(output.includes("chat=[chat-id]"), true);
  assert.equal(output.includes("100000"), true);
  assert.equal(output.includes("9876543210"), true);
});

test("authorizes only bounded text in the target chat from an allowed sender", () => {
  const allowed = ["42"];
  assert.equal(
    authorizeTelegramCommand(
      { chatId: -123, senderId: 42, text: "/health" },
      "-123",
      allowed,
    ),
    true,
  );
  assert.equal(
    authorizeTelegramCommand(
      { chatId: -123, senderId: 9, text: "/health" },
      "-123",
      allowed,
    ),
    false,
  );
  assert.equal(
    authorizeTelegramCommand(
      { chatId: -999, senderId: 42, text: "/health" },
      "-123",
      allowed,
    ),
    false,
  );
  assert.equal(
    authorizeTelegramCommand(
      { chatId: -123, senderId: 42, text: "x".repeat(513) },
      "-123",
      allowed,
    ),
    false,
  );
  assert.equal(
    authorizeTelegramCommand({ chatId: -123, senderId: 42 }, "-123", allowed),
    false,
  );
});

function restore(name: string, value: string | undefined): void {
  // Callers use only the three explicitly captured environment-variable names.
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else Reflect.set(process.env, name, value);
}
