"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  formatAddress,
  formatNumber,
  liquidationPrice,
  validateAddress,
  type HealthLevel,
} from "@/lib/format";
import type { HealthResponse, TransferItem, TransfersResponse } from "@/lib/server";

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string }): Promise<unknown>;
    };
  }
}

const levelDetails: Record<
  HealthLevel,
  { title: string; icon: string; description: string; color: string }
> = {
  SAFE: {
    title: "SAFE",
    icon: "✓",
    description: "Your loan is below the warning threshold. Keep a buffer as BTC prices move.",
    color: "safe",
  },
  WARNING: {
    title: "WARNING",
    icon: "!",
    description: "Your loan is approaching the danger zone. Consider adding collateral or repaying MUSD.",
    color: "warning",
  },
  DANGER: {
    title: "DANGER",
    icon: "⚠",
    description: "Your loan is near liquidation. Add collateral or repay MUSD as soon as possible.",
    color: "danger",
  },
  NO_LOAN: {
    title: "NO LOAN",
    icon: "—",
    description: "No active MUSD loan was found for this address.",
    color: "neutral",
  },
};

function apiMessage(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "error" in value) {
    return typeof value.error === "string" ? value.error : undefined;
  }
  return undefined;
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.address === "string" &&
    typeof result.updatedAt === "string" &&
    typeof result.troveActive === "boolean" &&
    typeof result.collateralBtc === "number" &&
    Number.isFinite(result.collateralBtc) &&
    typeof result.debtMusd === "number" &&
    Number.isFinite(result.debtMusd) &&
    typeof result.btcPriceUsd === "number" &&
    Number.isFinite(result.btcPriceUsd) &&
    typeof result.ltvPercent === "number" &&
    Number.isFinite(result.ltvPercent) &&
    (result.level === "SAFE" ||
      result.level === "WARNING" ||
      result.level === "DANGER" ||
      result.level === "NO_LOAN")
  );
}

function isTransfersResponse(value: unknown): value is TransfersResponse {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.address === "string" &&
    typeof result.updatedAt === "string" &&
    typeof result.partial === "boolean" &&
    Array.isArray(result.transfers) &&
    result.transfers.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const transfer = item as Record<string, unknown>;
      return (
        (transfer.direction === "IN" || transfer.direction === "OUT") &&
        typeof transfer.amount === "string" &&
        typeof transfer.counterparty === "string" &&
        typeof transfer.block === "string" &&
        typeof transfer.txHash === "string" &&
        typeof transfer.logIndex === "number" &&
        typeof transfer.explorerLink === "string"
      );
    })
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function requestError(response: Response, body: unknown, fallback: string): Error {
  return new Error(
    response.status >= 500
      ? fallback
      : apiMessage(body) ?? fallback,
  );
}

function staleMessage(updatedAt: string): string {
  const timestamp = new Date(updatedAt).getTime();
  if (Number.isNaN(timestamp)) return "Showing previously cached data.";
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  return `Showing data from ${minutes} min ago.`;
}

function retryDelay(attempt: number): number | undefined {
  switch (attempt) {
    case 0:
      return 3_000;
    case 1:
      return 6_000;
    case 2:
      return 12_000;
    default:
      return undefined;
  }
}

function getLevelDetails(level: HealthLevel | null) {
  switch (level) {
    case "SAFE":
      return levelDetails.SAFE;
    case "WARNING":
      return levelDetails.WARNING;
    case "DANGER":
      return levelDetails.DANGER;
    case "NO_LOAN":
      return levelDetails.NO_LOAN;
    default:
      return null;
  }
}

export default function Dashboard() {
  const [address, setAddress] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [partialTransfers, setPartialTransfers] = useState(false);
  const [staleTransfers, setStaleTransfers] = useState(false);
  const [transferUpdatedAt, setTransferUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [copied, setCopied] = useState(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const healthRef = useRef<HealthResponse | null>(null);
  const requestIdRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);

  const fetchAddress = useCallback(async (value: string) => {
    const valid = validateAddress(value);
    if (!valid) {
      requestIdRef.current += 1;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setError("Enter a valid Mezo EVM address to check its loan.");
      healthRef.current = null;
      setHealth(null);
      setTransfers([]);
      addressInput.current?.focus();
      return;
    }

    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const requestId = ++requestIdRef.current;
    const sameAddress =
      healthRef.current?.address.toLowerCase() === valid.toLowerCase();
    if (!sameAddress) {
      healthRef.current = null;
      setHealth(null);
      setTransfers([]);
      setPartialTransfers(false);
      setStaleTransfers(false);
      setTransferUpdatedAt(null);
      setLastUpdated(null);
    }
    setAddress(valid);
    setError(null);
    setTransferError(null);
    setLoading(true);
    try {
      try {
        localStorage.setItem("musd-guardian-address", valid);
      } catch {
        // Storage can be unavailable in private browsing; the current lookup still works.
      }
      const url = new URL(window.location.href);
      url.searchParams.set("address", valid);
      window.history.replaceState({}, "", url);
      const loadTransfers = async (): Promise<void> => {
        try {
          const response = await fetch(
            `/api/transfers?address=${encodeURIComponent(valid)}`,
            { cache: "no-store" },
          );
          const body = await readJson(response);
          if (requestId !== requestIdRef.current) return;
          if (!response.ok) {
            setTransferError(
              requestError(response, body, "Recent activity could not be loaded.").message,
            );
            return;
          }
          if (
            !isTransfersResponse(body) ||
            body.address.toLowerCase() !== valid.toLowerCase()
          ) {
            setTransferError("Recent activity returned an invalid response.");
            return;
          }
          setTransfers(body.transfers);
          setPartialTransfers(body.partial);
          setStaleTransfers(body.stale === true);
          setTransferUpdatedAt(body.updatedAt);
          setTransferError(null);
        } catch {
          if (requestId === requestIdRef.current) {
            setTransferError("Recent activity could not be loaded.");
          }
        }
      };
      void loadTransfers();

      const loadHealth = async (retryIndex: number): Promise<void> => {
        if (requestId !== requestIdRef.current) return;
        setLoading(true);
        try {
          const response = await fetch(
            `/api/health?address=${encodeURIComponent(valid)}`,
            { cache: "no-store" },
          );
          const body = await readJson(response);
          if (!response.ok) {
            throw requestError(response, body, "The testnet RPC is slow. Please retry.");
          }
          if (
            !isHealthResponse(body) ||
            body.address.toLowerCase() !== valid.toLowerCase()
          ) {
            throw new Error("Loan health returned an invalid response. Please retry.");
          }
          healthRef.current = body;
          setHealth(body);
          setError(null);
          const updatedAt = new Date(body.updatedAt);
          setLastUpdated(Number.isNaN(updatedAt.getTime()) ? new Date() : updatedAt);
        } catch (healthError) {
          if (requestId !== requestIdRef.current) return;
          if (!healthRef.current || healthRef.current.address.toLowerCase() !== valid.toLowerCase()) {
            setError(
              healthError instanceof Error
                ? healthError.message
                : "Could not load loan health.",
            );
            const delay = retryDelay(retryIndex);
            if (delay !== undefined) {
              retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                void loadHealth(retryIndex + 1);
              }, delay);
            }
          } else {
            setError(null);
          }
        } finally {
          if (requestId === requestIdRef.current) setLoading(false);
        }
      };
      await loadHealth(0);
    } catch {
      if (requestId === requestIdRef.current) {
        if (!healthRef.current) setError("Could not prepare the loan lookup.");
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let savedTheme: string | null = null;
    try {
      savedTheme = localStorage.getItem("musd-guardian-theme");
    } catch {
      // Theme preference is optional.
    }
    const params = new URLSearchParams(window.location.search);
    const sharedAddress = params.get("address");
    let initialAddress = sharedAddress;
    if (!initialAddress) {
      try {
        initialAddress = localStorage.getItem("musd-guardian-address");
      } catch {
        initialAddress = null;
      }
    }
    const timer = window.setTimeout(() => {
      if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
      if (initialAddress) void fetchAddress(initialAddress);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAddress]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!health) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchAddress(address);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [address, fetchAddress, health]);

  const viewLevel = health?.level ?? null;
  const level = getLevelDetails(viewLevel);
  const liquidationBtcPrice = useMemo(
    () =>
      health?.troveActive
        ? liquidationPrice(
            health.debtMusd,
            health.collateralBtc,
            health.liquidationLtvPercent,
          )
        : null,
    [health],
  );

  async function connectWallet(): Promise<void> {
    if (!window.ethereum) {
      setError("MetaMask was not detected. Paste an address to continue.");
      return;
    }
    try {
      const accounts: unknown = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        throw new Error("No wallet address was returned.");
      }
      const valid = validateAddress(accounts[0]);
      if (!valid) throw new Error("The wallet returned an invalid address.");
      setAddress(valid);
      await fetchAddress(valid);
    } catch (walletError) {
      setError(walletError instanceof Error ? walletError.message : "Wallet connection failed.");
    }
  }

  function toggleTheme(): void {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("musd-guardian-theme", next);
    } catch {
      // Theme preference is optional.
    }
  }

  async function copyShareLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy the link. You can copy the URL from your browser.");
    }
  }

  const telegramUrl = process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL;
  const repoUrl = process.env.NEXT_PUBLIC_REPO_URL;

  return (
    <main className={`site-shell ${theme}`}>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <header className="topbar">
        <Link className="brand" href="/" aria-label="MUSD Guardian home">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>MUSD <b>Guardian</b></span>
        </Link>
        <div className="header-actions">
          <span className="network-badge"><span className="online-dot" /> Mezo Testnet</span>
          <button className="icon-button" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? "☼" : "☾"}
          </button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> YOUR LOAN, IN VIEW</div>
          <h1>Stay ahead of<br /><span>liquidation.</span></h1>
          <p>Know your Bitcoin-backed loan is safe before liquidation does.</p>
        </div>
        <div className="hero-stat" aria-label="Mezo testnet monitoring">
          <span className="hero-stat-icon" aria-hidden="true">↗</span>
          <span>Onchain, read-only</span>
          <small>Mezo Testnet</small>
        </div>
      </section>

      <section className="lookup-panel" aria-label="Check a loan">
        <div className="lookup-heading">
          <div>
            <span className="section-kicker">ADDRESS LOOKUP</span>
            <h2>Check a MUSD loan</h2>
          </div>
          <span className="lookup-lock">◈ &nbsp;Public data only</span>
        </div>
        <form
          className="lookup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void fetchAddress(address);
          }}
        >
          <label className="sr-only" htmlFor="address">Mezo testnet wallet address</label>
          <span className="input-icon" aria-hidden="true">⌕</span>
          <input
            ref={addressInput}
            id="address"
            name="address"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste a Mezo testnet address (0x...)"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button className="button button-wallet" type="button" onClick={() => void connectWallet()}>
            <span aria-hidden="true">◇</span> Use my wallet
          </button>
          <button className="button button-primary" type="submit" disabled={loading}>
            {loading ? <span className="spinner" aria-hidden="true" /> : null}
            {loading ? "Checking" : "Check loan"} <span aria-hidden="true">→</span>
          </button>
        </form>
        {error && !health ? (
          <div className="error-banner" role="alert">
            <span aria-hidden="true">!</span>
            <span>{error}</span>
            <button type="button" onClick={() => void fetchAddress(address)}>Retry</button>
          </div>
        ) : null}
      </section>

      {loading && !health ? (
        <section className="result-grid" aria-label="Loading loan data" aria-live="polite">
          <div className="card health-card skeleton-card"><span className="skeleton wide" /><span className="skeleton number" /><span className="skeleton wide" /><span className="skeleton bar" /></div>
          <div className="card details-card"><span className="skeleton wide" /><span className="skeleton metric" /><span className="skeleton metric" /><span className="skeleton metric" /></div>
        </section>
      ) : null}

      {health && level ? (
        <>
          <section className={`result-grid level-${level.color}`} aria-label="Loan health results">
            <article className="card health-card">
              <div className="card-topline">
                <span className="section-kicker">LOAN HEALTH</span>
                <div className="result-actions">
                  <span className={`level-pill level-pill-${level.color}`}><span aria-hidden="true">{level.icon}</span> {level.title}</span>
                  <button className="refresh-button" type="button" onClick={() => void fetchAddress(address)} disabled={loading} aria-label="Refresh loan data">
                    <span aria-hidden="true">↻</span> Refresh
                  </button>
                </div>
              </div>
              {health.stale ? (
                <p className="stale-note">{staleMessage(health.updatedAt)}</p>
              ) : null}
              <div className="ltv-row">
                <div>
                  <div className="ltv-number">{health.troveActive ? `${formatNumber(health.ltvPercent, 2)}%` : "—"}</div>
                  <div className="metric-caption">LOAN-TO-VALUE</div>
                </div>
                <p className={`level-description description-${level.color}`}>
                  <span aria-hidden="true">{level.icon}</span> {level.description}
                </p>
              </div>
              {health.troveActive ? (
                <svg
                  className="ltv-meter"
                  role="meter"
                  aria-label="Loan-to-value"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, health.ltvPercent)}
                  aria-valuetext={`${formatNumber(health.ltvPercent, 2)} percent, ${level.title}`}
                  viewBox="0 0 1000 52"
                  preserveAspectRatio="none"
                >
                  <rect x="0" y="10" width={health.warnLtv * 10} height="9" className="meter-safe-zone" />
                  <rect
                    x={health.warnLtv * 10}
                    y="10"
                    width={(health.dangerLtv - health.warnLtv) * 10}
                    height="9"
                    className="meter-warning-zone"
                  />
                  <rect
                    x={health.dangerLtv * 10}
                    y="10"
                    width={(100 - health.dangerLtv) * 10}
                    height="9"
                    className="meter-danger-zone"
                  />
                  <rect
                    x="0"
                    y="10"
                    width={Math.max(0, Math.min(1000, health.ltvPercent * 10))}
                    height="9"
                    className={`meter-fill meter-fill-${level.color}`}
                  />
                  {[health.warnLtv, health.dangerLtv, 90].map((mark, index) => (
                    <g key={`${mark}-${index}`} className={`meter-tick meter-tick-${index}`}>
                      <line x1={mark * 10} x2={mark * 10} y1="6" y2="25" />
                      <text x={mark * 10} y="43" textAnchor="middle">
                        {index === 0 ? "WARN" : index === 1 ? "DANGER" : "90% LIQ."}
                      </text>
                    </g>
                  ))}
                  <text x="0" y="43" textAnchor="start" className="meter-end-label">0%</text>
                  <text x="1000" y="43" textAnchor="end" className="meter-end-label">100%</text>
                </svg>
              ) : (
                <div className="no-loan-callout"><span aria-hidden="true">◌</span> No active loan found for this address.</div>
              )}
              <div className="loan-details">
                <Metric label="COLLATERAL" value={formatNumber(health.collateralBtc, 6)} unit="BTC" />
                <Metric label="TOTAL DEBT" value={formatNumber(health.debtMusd, 2)} unit="MUSD" />
                <Metric label="BTC PRICE" value={`$${formatNumber(health.btcPriceUsd, 2)}`} unit="USD" />
                <Metric label="TO LIQUIDATION" value={health.troveActive ? `${formatNumber(health.distanceToLiquidationPercent, 2)} pp` : "—"} unit={health.troveActive ? "percentage points" : ""} />
              </div>
              {health.troveActive && liquidationBtcPrice !== null ? (
                <div className="liquidation-price">
                  <div className="price-comparison-heading">
                    <span className="liquidation-icon" aria-hidden="true">⌁</span>
                    <span><b>What would liquidation price be?</b><small>Estimated BTC price at 90% LTV</small></span>
                  </div>
                  <div className="price-comparison">
                    <div className="price-point">
                      <small>Current BTC price</small>
                      <strong>${formatNumber(health.btcPriceUsd, 2)} <small>USD</small></strong>
                    </div>
                    <span className="price-arrow" aria-hidden="true">→</span>
                    <div className="price-point price-liquidation">
                      <small>At liquidation</small>
                      <strong>${formatNumber(liquidationBtcPrice, 2)} <small>USD</small></strong>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="card-foot">
                <span>Address <code>{formatAddress(health.address)}</code></span>
                <button type="button" className="text-button" onClick={() => void copyShareLink()}>{copied ? "Copied!" : "Share result ↗"}</button>
              </div>
            </article>

            <article className="card activity-card">
              <div className="card-topline">
                <div><span className="section-kicker">ONCHAIN HISTORY</span><h2>Recent MUSD activity</h2></div>
                <span className="history-count">{transfers.length} events</span>
              </div>
              {transferError ? <div className="activity-error" role="status">{transferError}</div> : null}
              {staleTransfers && transferUpdatedAt ? (
                <p className="stale-note">{staleMessage(transferUpdatedAt)}</p>
              ) : null}
              {partialTransfers ? <p className="partial-note">Showing partial results; the testnet query reached its work limit.</p> : null}
              {transfers.length > 0 ? (
                <ul className="activity-list">
                    {transfers.map((transfer) => (
                      <li key={`${transfer.txHash}-${transfer.logIndex}`} className="activity-item">
                        <span className={`activity-direction ${transfer.direction === "IN" ? "direction-in" : "direction-out"}`} aria-label={transfer.direction === "IN" ? "Incoming" : "Outgoing"}>{transfer.direction === "IN" ? "↓" : "↑"}</span>
                        <span className="activity-main"><b>{transfer.direction === "IN" ? "Received" : "Sent"}</b><small>{formatAddress(transfer.counterparty)} · block {transfer.block}</small></span>
                        <span className="activity-amount">{transfer.direction === "IN" ? "+" : "−"}{formatNumber(Number(transfer.amount), 2)} <small>MUSD</small></span>
                        <a href={transfer.explorerLink} target="_blank" rel="noreferrer" aria-label={`View transaction ${transfer.txHash} on Mezo Explorer`} className="activity-link">↗</a>
                      </li>
                    ))}
                </ul>
              ) : !transferError ? (
                <div className="empty-activity"><span aria-hidden="true">⌁</span><b>No recent transfers found</b><small>MUSD transfers from the configured recent block range will appear here.</small></div>
              ) : null}
              <div className="activity-foot">
                <span>Transfer events on Mezo Testnet</span>
                {lastUpdated ? <span>Updated {lastUpdated.toLocaleTimeString()}</span> : null}
              </div>
            </article>
          </section>
          {lastUpdated ? (
            <div className="updated-row"><span><span className="online-dot" /> Live data · updated {lastUpdated.toLocaleTimeString()}</span><button className="text-button" type="button" onClick={() => void fetchAddress(address)} disabled={loading}>Refresh now ↻</button></div>
          ) : null}
        </>
      ) : null}

      <section className="telegram-section">
        <div className="telegram-icon" aria-hidden="true">➤</div>
        <div className="telegram-copy">
          <span className="section-kicker">STAY IN THE LOOP</span>
          <h2>Get alerts on Telegram</h2>
          <p>Get notified when the configured loan moves into a riskier LTV range.</p>
          <div className="telegram-steps">
            <span><i>1</i> Open the bot</span><span><i>2</i> Press Start</span><span><i>3</i> Send <code>/health</code></span>
          </div>
          <small className="subscription-note">Alerts are sent for the address the bot operator configured. Per-user subscriptions are on the roadmap.</small>
        </div>
        {telegramUrl ? <a className="button button-telegram" href={telegramUrl} target="_blank" rel="noreferrer">Open Telegram <span aria-hidden="true">↗</span></a> : <span className="telegram-not-configured">Bot link not configured</span>}
      </section>

      <footer className="footer">
        <div className="footer-left"><Link className="brand footer-brand" href="/"><span className="brand-mark" aria-hidden="true">M</span><span>MUSD <b>Guardian</b></span></Link><span>Built for the Mezo Buildathon, Track 2: Access and Distribution</span></div>
        <div className="footer-links">
          <span className="network-badge"><span className="online-dot" /> Mezo Testnet</span>
          <a href="https://explorer.test.mezo.org" target="_blank" rel="noreferrer">Explorer ↗</a>
          {repoUrl ? <a href={repoUrl} target="_blank" rel="noreferrer">GitHub ↗</a> : null}
        </div>
      </footer>
    </main>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value} <small>{unit}</small></span>
    </div>
  );
}
