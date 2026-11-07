"use client";

import { useRef, useState } from "react";
import { formatUnits, isHex } from "viem";
import type { HealthResponse } from "@/lib/server";
import { EXPLORER_URL } from "@/lib/constants";
import {
  type ProtectAction,
  type ProtectMetrics,
  type ProtectPlan,
} from "@/lib/protect";
import { calculateTargetAmount } from "@/lib/protect-math";
import {
  connectProtectedAccount,
  isMezoTestnet,
  protectWalletTransaction,
  switchToMezoTestnet,
  walletErrorMessage,
} from "@/lib/protect-wallet";
import type { EthereumProvider } from "@/lib/protect-wallet";
import { formatNumber } from "@/lib/format";

type ReceiptStatus = "idle" | "submitting" | "pending" | "confirmed" | "failed" | "timed_out";

interface ProtectPanelProps {
  health: HealthResponse;
  onRefresh: () => void;
}

function isEthereumProvider(value: unknown): value is EthereumProvider {
  return typeof value === "object" && value !== null && "request" in value &&
    typeof value.request === "function";
}

function isProtectPlan(value: unknown): value is ProtectPlan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Record<string, unknown>;
  return typeof plan.target === "string" && typeof plan.calldata === "string" &&
    typeof plan.value === "string" && (plan.action === "add_collateral" || plan.action === "repay") &&
    typeof plan.amount === "string" &&
    (typeof plan.estimatedGas === "string" || plan.estimatedGas === null);
}

function metricValue(value: number | null): string {
  return value === null ? "Unavailable" : formatNumber(value, 2);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("Wallet request timed out.")), milliseconds);
    }),
  ]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

export default function ProtectPanel({ health, onRefresh }: ProtectPanelProps) {
  const [action, setAction] = useState<ProtectAction>("add_collateral");
  const [amount, setAmount] = useState("");
  const [targetLtv, setTargetLtv] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [walletMessage, setWalletMessage] = useState<string | null>(null);
  const [plan, setPlan] = useState<ProtectPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [receiptStatus, setReceiptStatus] = useState<ReceiptStatus>("idle");
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const actionLock = useRef(false);

  function getWallet(): EthereumProvider | null {
    if (typeof window === "undefined" || !isEthereumProvider(window.ethereum)) {
      setWalletMessage("No compatible browser wallet was found. Install or enable a wallet to continue.");
      return null;
    }
    return window.ethereum;
  }

  async function connect(): Promise<void> {
    const wallet = getWallet();
    if (!wallet) return;
    setBusy(true);
    setWalletMessage(null);
    try {
      const connected = await withTimeout(
        connectProtectedAccount(wallet, health.address),
        120_000,
      );
      setAccount(connected);
      const onCorrectNetwork = await isMezoTestnet(wallet);
      setWrongNetwork(!onCorrectNetwork);
      if (!onCorrectNetwork) {
        setWalletMessage("Your wallet is connected to a different network. Switch to Mezo Testnet before continuing.");
      }
    } catch (error) {
      setAccount(null);
      setWalletMessage(walletErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeNetwork(): Promise<void> {
    const wallet = getWallet();
    if (!wallet || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setWalletMessage(null);
    try {
      await withTimeout(switchToMezoTestnet(wallet), 120_000);
      const onCorrectNetwork = await isMezoTestnet(wallet);
      setWrongNetwork(!onCorrectNetwork);
      setWalletMessage(onCorrectNetwork ? "Wallet connected to Mezo Testnet." : "Could not switch to Mezo Testnet.");
    } catch (error) {
      setWalletMessage(walletErrorMessage(error));
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  }

  function fillTargetAmount(): void {
    const target = Number(targetLtv);
    if (!Number.isFinite(target) || target <= 0 || target >= 90) {
      setWalletMessage("Enter a target LTV greater than 0% and below 90%.");
      return;
    }
    const required = calculateTargetAmount(
      action,
      health.collateralBtc,
      health.debtMusd,
      health.btcPriceUsd,
      target,
    );
    if (required <= 0) {
      setWalletMessage("The current loan is already at or below that target LTV.");
      return;
    }
    setAmount(required.toFixed(8).replace(/\.?0+$/, ""));
    setPlan(null);
    setWalletMessage(null);
  }

  async function requestPlan(): Promise<void> {
    if (actionLock.current || busy) return;
    if (!account || account.toLowerCase() !== health.address.toLowerCase()) {
      setWalletMessage("Connect the wallet that owns this trove before building a transaction.");
      return;
    }
    const wallet = getWallet();
    if (!wallet) return;
    try {
      if (!(await isMezoTestnet(wallet))) {
        setWrongNetwork(true);
        setWalletMessage("Switch to Mezo Testnet before building a transaction.");
        return;
      }
    } catch (error) {
      setWalletMessage(walletErrorMessage(error));
      return;
    }
    actionLock.current = true;
    setBusy(true);
    setPlan(null);
    setWalletMessage(null);
    try {
      const response = await fetch("/api/protect/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: health.address, action, amount }),
        signal: AbortSignal.timeout(28_000),
        cache: "no-store",
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof result === "object" && result !== null && "error" in result &&
          typeof result.error === "string"
          ? result.error
          : "The transaction plan could not be built.";
        throw new Error(message);
      }
      if (!isProtectPlan(result)) throw new Error("The server returned an invalid transaction plan.");
      setPlan(result);
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : "The transaction plan could not be built.");
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  }

  async function signAndSend(): Promise<void> {
    if (actionLock.current || busy || !plan || !account) return;
    const wallet = getWallet();
    if (!wallet) return;
    actionLock.current = true;
    setBusy(true);
    setReceiptStatus("submitting");
    setReceiptMessage(null);
    setWalletMessage(null);
    try {
      if (!(await isMezoTestnet(wallet))) {
        setWrongNetwork(true);
        setReceiptStatus("idle");
        setWalletMessage("Your wallet changed networks. Switch to Mezo Testnet before signing.");
        return;
      }
      const sent: unknown = await withTimeout(
        wallet.request({
          method: "eth_sendTransaction",
          params: [protectWalletTransaction(plan, account)],
        }),
        120_000,
      );
      if (!isHex(sent, { strict: true }) || sent.length !== 66) {
        throw new Error("The wallet did not return a valid transaction hash.");
      }
      setTransactionHash(sent);
      setReceiptStatus("pending");
      setBusy(false);
      await pollReceipt(sent);
    } catch (error) {
      setReceiptStatus("idle");
      setWalletMessage(walletErrorMessage(error));
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  }

  async function pollReceipt(hash: string): Promise<void> {
    const stopAt = Date.now() + 180_000;
    while (Date.now() < stopAt) {
      try {
        const response = await fetch(
          `/api/protect/receipt?hash=${encodeURIComponent(hash)}`,
          { cache: "no-store", signal: AbortSignal.timeout(12_000) },
        );
        if (response.ok) {
          const result: unknown = await response.json();
          if (typeof result === "object" && result !== null && "status" in result) {
            if (result.status === "confirmed") {
              setReceiptStatus("confirmed");
              setReceiptMessage("Transaction confirmed on Mezo Testnet.");
              onRefresh();
              return;
            }
            if (result.status === "failed") {
              setReceiptStatus("failed");
              setReceiptMessage("The transaction was mined but reverted. Open the explorer for details.");
              return;
            }
          }
        }
      } catch {
        // A temporary receipt API failure should not stop confirmation polling.
      }
      await wait(4_000);
    }
    setReceiptStatus("timed_out");
    setReceiptMessage("Still pending after 3 minutes. Check the transaction on Mezo Explorer.");
  }

  const isRepay = action === "repay";

  return (
    <section className="protect-panel" aria-labelledby="protect-heading">
      <div className="protect-heading">
        <div><span className="section-kicker">USER-SIGNED ACTIONS</span><h3 id="protect-heading">Protect my loan</h3></div>
        <span className="network-badge">Mezo Testnet</span>
      </div>
      <p className="protect-privacy">
        MUSD Guardian never holds your keys. You review and sign every transaction in your own wallet. Testnet only, not financial advice.
      </p>
      <div className="protect-tabs" role="tablist" aria-label="Protection action">
        <button type="button" role="tab" aria-selected={!isRepay} onClick={() => {
          setAction("add_collateral"); setPlan(null); setWalletMessage(null);
        }}>Add collateral (BTC)</button>
        <button type="button" role="tab" aria-selected={isRepay} onClick={() => {
          setAction("repay"); setPlan(null); setWalletMessage(null);
        }}>Repay MUSD</button>
      </div>
      <div className="protect-inputs">
        <label>
          Amount ({isRepay ? "MUSD" : "BTC"})
          <input
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => { setAmount(event.target.value); setPlan(null); }}
            placeholder={isRepay ? "0.00" : "0.00000000"}
          />
        </label>
        <div className="target-ltv-controls">
          <label>
            Target LTV (%)
            <input
              inputMode="decimal"
              value={targetLtv}
              onChange={(event) => setTargetLtv(event.target.value)}
              placeholder="e.g. 65"
            />
          </label>
          <button type="button" className="button button-wallet" onClick={fillTargetAmount}>Fill amount</button>
        </div>
      </div>
      <p className="protect-hint">
        {isRepay
          ? "Repay burns MUSD directly from the connected wallet; this verified contract does not use ERC-20 allowance, so no approval is requested."
          : "BTC is sent as transaction value to add collateral to this active trove."}
      </p>
      {!account ? (
        <button className="button button-wallet" type="button" onClick={() => void connect()} disabled={busy}>
          {busy ? "Connecting…" : "Connect wallet"}
        </button>
      ) : (
        <p className="protect-account">Wallet: <code>{account.slice(0, 6)}…{account.slice(-4)}</code></p>
      )}
      {wrongNetwork ? (
        <button className="button button-wallet" type="button" onClick={() => void changeNetwork()} disabled={busy}>
          {busy ? "Switching…" : "Switch to Mezo Testnet"}
        </button>
      ) : null}
      {walletMessage ? <p className="protect-message" role="status">{walletMessage}</p> : null}

      {plan ? (
        <div className="protect-review">
          <h4>Review before signing</h4>
          <ol>
            <li>Send {plan.amount} {isRepay ? "MUSD to repay trove debt" : "BTC as additional trove collateral"}.</li>
            <li>From <code>{plan.address}</code>.</li>
            <li>To <a href={`${EXPLORER_URL}/address/${plan.target}`} target="_blank" rel="noopener noreferrer">{plan.target} ↗</a>.</li>
            <li>Estimated network fee: {plan.estimatedFeeWei === null
              ? "unavailable; review the wallet estimate"
              : `${formatNumber(Number(formatUnits(BigInt(plan.estimatedFeeWei), 18)), 8)} BTC`}</li>
          </ol>
          <ProtectComparison title="Before" metrics={plan.before} />
          <ProtectComparison title="After (estimated)" metrics={plan.after} />
          {plan.warnings.map((warning) => <p className="protect-warning" key={warning}>{warning}</p>)}
          <p className="protect-testnet-warning">This is a Mezo TESTNET transaction. Check the details in your wallet.</p>
          <button className="button button-primary" type="button" onClick={() => void signAndSend()} disabled={busy || receiptStatus === "pending"}>
            {busy ? "Waiting for wallet…" : "Sign transaction in wallet"}
          </button>
        </div>
      ) : account && !wrongNetwork ? (
        <button className="button button-primary" type="button" onClick={() => void requestPlan()} disabled={busy || !amount}>
          {busy ? "Simulating transaction…" : "Build transaction for review"}
        </button>
      ) : null}

      {transactionHash ? (
        <div className="protect-receipt" role="status">
          <p>
            {receiptStatus === "submitting" ? "Waiting for wallet confirmation…" :
              receiptStatus === "pending" ? "Transaction pending…" :
                receiptStatus === "confirmed" ? "Confirmed" :
                  receiptStatus === "failed" ? "Failed" : "Confirmation timed out"}
          </p>
          <a href={`${EXPLORER_URL}/tx/${transactionHash}`} target="_blank" rel="noopener noreferrer">
            View transaction {transactionHash.slice(0, 10)}… on Mezo Explorer ↗
          </a>
          {receiptMessage ? <p>{receiptMessage}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function ProtectComparison({ title, metrics }: { title: string; metrics: ProtectMetrics }) {
  return (
    <div className="protect-comparison">
      <b>{title}</b>
      <span>LTV <strong>{formatNumber(metrics.ltvPercent, 2)}%</strong></span>
      <span>Level <strong>{metrics.level}</strong></span>
      <span>Liquidation price <strong>{metricValue(metrics.liquidationPriceUsd)} USD</strong></span>
      <span>Buffer to liquidation <strong>{metricValue(metrics.bufferToLiquidationPercent)}%</strong></span>
    </div>
  );
}
