# MUSD Guardian

Read-only alerts and a dashboard for public MUSD activity on Mezo Testnet.
The watcher and dashboard query public blockchain data; they do not hold
private keys, sign transactions, or send transactions.

## Run the watcher

```sh
npm ci
cp .env.example .env
# Fill in WATCH_ADDRESS and Telegram settings without committing .env.
npm run start
```

For local development, `npm run watch` runs the TypeScript source directly.
When `PORT` is set, the watcher exposes only `GET /health`. Persistent state is
written to `STATE_PATH` (default `./state.json`).

The container stores state at `/data/state.json`; mount a persistent writable
volume at `/data`. The container is designed to run as a non-root user with a
read-only root filesystem.

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
logs for the configured or requested address. The watcher can send alert text
to its single configured Telegram chat. It cannot access wallet private keys,
sign or submit transactions, or guarantee the accuracy or availability of
testnet RPC data.

The code validates environment and API inputs, restricts browser connections
with a Content Security Policy, applies security headers, bounds upstream
requests, and rate-limits dashboard APIs. Telegram commands are limited to the
configured chat and allowed sender IDs. `state.json` is validated and written
atomically with restrictive file permissions.

The dashboard's optional Upstash limiter is shared; without it the in-memory
fallback is per server instance only. The Telegram bot supports one configured
chat, not per-user subscriptions. Testnet RPC availability and upstream
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
