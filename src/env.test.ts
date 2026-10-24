import assert from "node:assert/strict";
import { after, test } from "node:test";
import { validateEnvironment } from "./env.js";

const names = [
  "WATCH_ADDRESS",
  "RPC_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_ALLOWED_USER_IDS",
  "START_LOOKBACK_BLOCKS",
  "HEALTH_POLL_SECONDS",
  "WARN_LTV",
  "DANGER_LTV",
  "PORT",
  "STATE_PATH",
] as const;
const original = new Map(names.map((name) => [name, Reflect.get(process.env, name)]));

after(() => {
  for (const [name, value] of original) {
    // Keys in this map come only from the fixed environment-variable list above.
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else Reflect.set(process.env, name, value);
  }
});

test("environment validation reports invalid keys without echoing values", () => {
  for (const name of names) Reflect.deleteProperty(process.env, name);
  const invalidValue = "sensitive-invalid-address-value";
  process.env.WATCH_ADDRESS = invalidValue;

  assert.throws(
    validateEnvironment,
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /WATCH_ADDRESS/);
      assert.equal(error.message.includes(invalidValue), false);
      return true;
    },
  );
});

test("environment validation rejects non-HTTPS RPC endpoints without echoing them", () => {
  for (const name of names) Reflect.deleteProperty(process.env, name);
  const invalidEndpoint = "http://rpc.example.invalid/private-token-value";
  process.env.RPC_URL = invalidEndpoint;

  assert.throws(
    validateEnvironment,
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /RPC_URL/);
      assert.equal(error.message.includes(invalidEndpoint), false);
      return true;
    },
  );
});
