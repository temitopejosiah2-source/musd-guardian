import { getAddress, type Hex } from "viem";
import type { ProtectPlan } from "./protect";

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export class WalletFlowError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export async function connectProtectedAccount(
  wallet: EthereumProvider,
  protectedAddress: string,
): Promise<string> {
  const accounts: unknown = await wallet.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new WalletFlowError("Your wallet did not return an account.");
  }
  let account: string;
  try {
    account = getAddress(accounts[0]);
  } catch {
    throw new WalletFlowError("Your wallet returned an invalid account.");
  }
  if (account.toLowerCase() !== protectedAddress.toLowerCase()) {
    throw new WalletFlowError(
      "The connected wallet does not match the loan address. Switch to the wallet that owns this trove.",
    );
  }
  return account;
}

export async function isMezoTestnet(wallet: EthereumProvider): Promise<boolean> {
  const chainId: unknown = await wallet.request({ method: "eth_chainId" });
  return typeof chainId === "string" && chainId.toLowerCase() === MEZO_CHAIN_ID;
}

export async function switchToMezoTestnet(wallet: EthereumProvider): Promise<void> {
  try {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: MEZO_CHAIN_ID }],
    });
  } catch (error) {
    if (walletErrorCode(error) !== 4902) throw error;
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: MEZO_CHAIN_ID,
        chainName: "Mezo Testnet",
        rpcUrls: ["https://rpc.test.mezo.org"],
        nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
        blockExplorerUrls: ["https://explorer.test.mezo.org"],
      }],
    });
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: MEZO_CHAIN_ID }],
    });
  }
}

export function protectWalletTransaction(plan: ProtectPlan, from: string): {
  from: string;
  to: string;
  data: Hex;
  value: Hex;
  chainId: string;
  gas?: Hex;
} {
  return {
    from: getAddress(from),
    to: plan.target,
    data: plan.calldata,
    value: plan.value,
    chainId: MEZO_CHAIN_ID,
    ...(plan.estimatedGas ? { gas: `0x${BigInt(plan.estimatedGas).toString(16)}` as Hex } : {}),
  };
}

export function walletErrorMessage(error: unknown): string {
  const code = walletErrorCode(error);
  if (code === 4001) return "You rejected the request in your wallet. No transaction was sent.";
  if (code === 4901 || code === 4902) return "Your wallet is not connected to Mezo Testnet. Switch networks and try again.";
  if (error instanceof WalletFlowError) return error.message;
  return "The wallet request failed. Check your wallet and try again.";
}

function walletErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

const MEZO_CHAIN_ID = `0x${(31611).toString(16)}`;
