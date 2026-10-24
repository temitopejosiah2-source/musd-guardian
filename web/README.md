# MUSD Guardian dashboard

Public, read-only Mezo Testnet dashboard for checking a MUSD trove and recent MUSD transfers.

## Run locally

```sh
cd web
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. RPC and contract reads run server-side; no wallet or signing is needed to inspect an address.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `RPC_URL` | No | `https://rpc.test.mezo.org` | Mezo Testnet JSON-RPC URL. Keep it server-only. |
| `WARN_LTV` | No | `70` | LTV at or above which a loan is WARNING. |
| `DANGER_LTV` | No | `80` | LTV at or above which a loan is DANGER. |
| `NEXT_PUBLIC_TELEGRAM_BOT_URL` | No | — | Link to the Telegram alert bot. |
| `NEXT_PUBLIC_REPO_URL` | No | — | Project repository URL. |
| `UPSTASH_REDIS_REST_URL` | No | — | Server-only shared rate-limit endpoint. |
| `UPSTASH_REDIS_REST_TOKEN` | No | — | Server-only shared rate-limit credential. |

The app uses the verified Mezo Testnet contract addresses and read interfaces copied from the guardian project. Never put RPC credentials or other secrets in a `NEXT_PUBLIC_` variable.

## Deploy to Vercel

1. Import the repository into Vercel.
2. Set **Root Directory** to `web`.
3. Configure the environment variables above in the Vercel project settings. Set the two `NEXT_PUBLIC_` links to the appropriate public URLs.
4. Deploy with the default Next.js build settings.

API routes run in the Node.js runtime. Their in-memory cache and rate limit are per server instance and are not a global distributed quota.

## Security

The browser calls only same-origin API routes; the server keeps `RPC_URL`
private and validates address/query inputs. Production responses use a nonce
Content Security Policy and security headers. The API has bounded upstream
work, 15-second response caching, and a sliding-window rate limit. Configure
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for a shared
serverless rate limit. Without both, the in-memory fallback is per instance
only and can be reset or bypassed across serverless instances.

The dashboard reads public testnet information only. It does not handle private
keys or send blockchain transactions. Testnet RPC availability is not
guaranteed. The project has not received an external security audit.

## Checks

```sh
npm ci
npm run check:env
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```
