# Hosting deployment

The bot polls Telegram and Mezo from one long-running process. Set `STORE=redis`
for a deployment that does not need persistent local disk.

## Railway

1. Connect the Git repository to a Railway service.
2. Select the repository `Dockerfile` as the build source.
3. Configure the environment variables in the table below. Set
   `STORE=redis` and provide an Upstash Redis REST URL and token.
4. Configure one running replica for the service and deploy. The Redis poller
   lock prevents concurrent pollers while a replacement instance starts.
5. In deployment logs, check for `Health poll: OK`.
6. Open `https://<your-service-domain>/health` and confirm it returns HTTP 200
   with `ok: true`. In Telegram send `/start`, then `/watch <address>` and
   `/health` to verify a live subscription.

## Render

1. Create a Web Service connected to the Git repository.
2. Choose Docker as the runtime so Render builds the repository `Dockerfile`.
3. Configure the environment variables in the table below. Set
   `STORE=redis` and provide an Upstash Redis REST URL and token.
4. Keep one running service instance and deploy. The Redis poller lock ensures
   only one instance polls Telegram and the chain at a time.
5. In deployment logs, check for `Health poll: OK`.
6. Open `https://<your-service-domain>/health` and confirm it returns HTTP 200
   with `ok: true`. In Telegram send `/start`, then `/watch <address>` and
   `/health` to verify a live subscription.

## Environment variables

Use placeholders here only; replace them with values from your own bot,
deployment, and Redis service.

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `<telegram-bot-token>` |
| `STORE` | `<redis>` |
| `UPSTASH_REDIS_REST_URL` | `https://<upstash-redis-endpoint>` |
| `UPSTASH_REDIS_REST_TOKEN` | `<upstash-redis-token>` |
| `PORT` | `<platform-provided-port>` |
| `ADMIN_CHAT_ID` | `<optional-admin-chat-id>` |
| `WATCH_ADDRESS` | `<optional-owner-migration-address>` |
| `TELEGRAM_CHAT_ID` | `<optional-owner-migration-chat-id>` |
| `RPC_URL` | `<optional-https-rpc-endpoint>` |
| `HEALTH_POLL_SECONDS` | `<poll-interval-seconds>` |
| `WARN_LTV` | `<warning-threshold>` |
| `DANGER_LTV` | `<danger-threshold>` |
| `MAX_ADDRESSES_PER_CHAT` | `<address-limit-per-chat>` |
| `MAX_CHATS` | `<chat-limit>` |
| `MAX_TOTAL_ADDRESSES` | `<total-address-limit>` |

`TELEGRAM_BOT_TOKEN` is required. `STORE` defaults to Redis when both Upstash
variables are set; otherwise it defaults to the file store. `WATCH_ADDRESS` and
`TELEGRAM_CHAT_ID` are only needed to migrate a legacy owner subscription.
`STATE_PATH` is only used by the file store.

## Single poller and token rotation

Do not configure multiple independent deployments with different Redis
databases. Keep the Redis credentials and bot configuration shared during a
rolling deployment; the `lock:poller` lease lets one instance poll while other
instances wait and retry. Confirm the new instance is healthy before removing
the old one.

To rotate the Telegram token, generate a replacement with BotFather, update
`TELEGRAM_BOT_TOKEN` in the hosting environment, and redeploy. Do not put the
token in source control or deployment logs.
