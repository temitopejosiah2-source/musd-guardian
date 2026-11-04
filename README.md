# MUSD Guardian

Read-only alerts and a dashboard for public MUSD activity on Mezo Testnet.
The watcher and dashboard query public blockchain data; they do not hold
private keys, sign transactions, or send transactions.

## Run the watcher

```sh
npm ci
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN. WATCH_ADDRESS and TELEGRAM_CHAT_ID are only needed
# if migrating an existing single-owner subscription.
npm run start
```

For local development, `npm run watch` runs the TypeScript source directly.
When `PORT` is set, the watcher exposes only `GET /health`. The default store is
file-backed at `STATE_PATH` (`./state.json`); choose `STORE=redis` for stateless
container hosting, or `STORE=memory` for tests and dry runs.
Transient Telegram, RPC, and Redis failures are retried independently with
exponential backoff. Set `RPC_TIMEOUT_MS`, `TELEGRAM_TIMEOUT_MS`, and
`REDIS_TIMEOUT_MS` to override their request timeouts; the Telegram HTTP
timeout remains longer than its long-poll timeout. The `/health` response
includes the last success time and outage state for Telegram, RPC, and Redis.
`SIMULATE_RPC_OUTAGE_MS` is a test hook that simulates an RPC outage from
process startup for the specified number of milliseconds.

The container uses a pinned slim Node image and runs as a non-root user. See
[docs/DEPLOY.md](./docs/DEPLOY.md) for hosting configuration.

## Wave 2: what changed

- Four per-chat health levels are supported: SAFE, MONITOR, WARNING, and
  DANGER, with ordered thresholds and three-point hysteresis. MONITOR messages
  are optional; WARNING and DANGER alerts include price buffers and inline
  check/snooze buttons.
- The bot samples the Mezo oracle price, sends configurable BTC price-drop
  alerts only for active watched troves, and supports persisted DANGER
  reminders and snoozes.
- Private chats can configure thresholds, monitor/price alerts, price-drop
  sensitivity, reminders, and snoozes using the command list in
  [docs/botfather-commands.txt](./docs/botfather-commands.txt).
- The dashboard supports the same four thresholds, shows liquidation and BTC
  price buffers, and links a displayed address directly to a Telegram start
  subscription.
- File, memory, and Upstash Redis stores persist subscriptions, alert settings,
  levels, oracle price samples, reminder/snooze state, cooldowns, transfer
  deduplication, poller position, and Telegram update offsets.

Privacy: the service stores each subscribing Telegram chat id, its watched
addresses and labels, alert thresholds, transfer preference, alert levels,
price-alert and reminder settings, recent oracle samples, snoozes, cooldowns,
processed-block and Telegram-update offsets, and recent transfer dedupe keys.
Use `/stop` and then `/stop confirm` to delete your chat's subscriptions,
settings, alert levels, snoozes, cooldowns, and transfer dedupe keys. Global
oracle samples, processed-block and Telegram-update offsets are retained.

## Run the dashboard

```sh
cd web
npm ci
cp .env.example .env.local
npm run dev
```

The dashboard makes same-origin API requests. Contract reads and RPC requests
are performed on the server; the browser never calls the RPC endpoint directly.
See [web/README.md](./web/README.md) for dashboard settings.

## Security

### Threat model

The app can read public Mezo Testnet balances, trove data, and MUSD transfer
logs for watched addresses. The watcher can send alert text to private Telegram
chats that subscribe. It cannot access wallet private keys, sign or submit
transactions, or guarantee the accuracy or availability of testnet RPC data.

The code validates environment and API inputs, restricts browser connections
with a Content Security Policy, applies security headers, bounds upstream
requests, and rate-limits dashboard APIs. Telegram commands are private-chat
only and rate-limited per chat. File-backed bot state is validated and written
atomically with restrictive file permissions.

The dashboard's optional Upstash limiter is shared; without it the in-memory
fallback is per server instance only. Testnet RPC availability and upstream
correctness remain external dependencies. This project has **not** had an
external security audit.

To rotate a Telegram token, revoke/regenerate it with BotFather and update
`TELEGRAM_BOT_TOKEN` in the deployment environment. To rotate a private RPC
credential, create a replacement with the RPC provider, update server-only
`RPC_URL`, deploy, and revoke the old credential. Never place either value in
a `NEXT_PUBLIC_` variable or commit it.

For reporting vulnerabilities, see [SECURITY.md](./SECURITY.md).

## Development checks

Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
and `npm audit --audit-level=high` from each project directory.

Use the plain Git hook with `git config core.hooksPath .githooks`. To scan
working files and Git history locally, install gitleaks and run
`scripts/scan-secrets.sh`.
