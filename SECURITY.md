# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Report a
vulnerability** feature for this repository. Include the affected version,
reproduction steps, impact, and any suggested mitigation. Do not include live
credentials in an issue or report. If private reporting is unavailable, contact
the repository maintainers through their GitHub profile and request a private
security channel.

## Supported versions

Only the latest source on the default branch is supported. Older releases,
deployment images, and third-party forks may not receive fixes.

## Scope and limitations

MUSD Guardian reads public Mezo Testnet blockchain data and sends optional
Telegram alerts. It does not store wallet private keys, sign transactions, or
submit blockchain transactions. It cannot prevent liquidation or protect users
from a compromised RPC provider, Telegram account, hosting platform, or
browser.

The dashboard validates requests, keeps RPC access server-side, applies
security headers, and rate-limits API requests. Without the optional Upstash
configuration, rate limiting is in-memory and per server instance. The
Telegram bot authorizes commands against one configured chat and permitted
sender IDs. Testnet RPC availability and data accuracy are outside this
project's control.

This project has **not** undergone an external security audit.
