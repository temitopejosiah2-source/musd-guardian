import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Address } from "viem";
import {
  buildProtectPlan,
  calculateTargetAmount,
  calculateProtectMetrics,
  enforceProtectLimits,
  mapProtectRevert,
  parseProtectAmount,
  ProtectPlanError,
  type ProtectAccess,
  type ProtectState,
} from "./protect";
import {
  connectProtectedAccount,
  isMezoTestnet,
  protectWalletTransaction,
  switchToMezoTestnet,
  walletErrorMessage,
  type EthereumProvider,
} from "./protect-wallet";

const owner = "0x3F68BC087AeB7F46b956F7F85Cd342B1274bF765" as Address;
const borrowerOperations = "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5" as Address;
const token = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" as Address;
const sortedTroves = "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA" as Address;

function stateOverrides(overrides: Partial<ProtectState> = {}): ProtectState {
  return {
    collateral: 1n * 10n ** 18n,
    debt: 2200n * 10n ** 18n,
    status: 1,
    principal: 2000n * 10n ** 18n,
    interestOwed: 200n * 10n ** 18n,
    price: 100_000n * 10n ** 18n,
    pricePrecision: 10n ** 18n,
    musdDecimals: 18,
    musdBalance: 1000n * 10n ** 18n,
    nativeBalance: 2n * 10n ** 18n,
    minimumNetDebt: 1800n * 10n ** 18n,
    minimumNetDebtFloor: 50n * 10n ** 18n,
    gasCompensation: 200n * 10n ** 18n,
    borrowerOperations,
    musdToken: token,
    sortedTroves,
    ...overrides,
  };
}

function fakeAccess(overrides: {
  state?: ProtectState;
  simulationError?: unknown;
} = {}): ProtectAccess {
  return {
    readState: async () => overrides.state ?? stateOverrides(),
    findInsertPosition: async () => [owner, token],
    simulate: async () => {
      if (overrides.simulationError) throw overrides.simulationError;
    },
    estimateGas: async () => 180_000n,
    getGasPrice: async () => 2n,
  };
}

describe("protection amount and protocol limits", () => {
  it("parses decimal amounts exactly and rejects malformed or overlong values", () => {
    expect(parseProtectAmount("1", 18)).toBe(10n ** 18n);
    expect(parseProtectAmount("0.001", 18)).toBe(10n ** 15n);
    expect(() => parseProtectAmount("0", 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount("1.", 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount(".5", 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount("1.2.3", 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount("-1", 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount("1e5", 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount(" 1", 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount("1".padEnd(41, "0"), 18)).toThrow(ProtectPlanError);
    expect(() => parseProtectAmount(`1.${"1".repeat(19)}`, 18)).toThrow(/decimal places/);
    expect(() => parseProtectAmount("1".repeat(1_000_000), 18)).toThrow(ProtectPlanError);
  });

  it("rejects amounts over BTC balance, MUSD balance, owed net debt, or minimum debt", () => {
    const state = stateOverrides();
    expect(() => enforceProtectLimits("add_collateral", 3n * 10n ** 18n, state))
      .toThrow(/BTC balance/);
    expect(() => enforceProtectLimits("repay", 1001n * 10n ** 18n, state))
      .toThrow(/MUSD balance/);
    expect(() => enforceProtectLimits("repay", 2001n * 10n ** 18n, {
      ...state,
      musdBalance: 2500n * 10n ** 18n,
    }))
      .toThrow(/net debt/);
    expect(() => enforceProtectLimits("repay", 501n * 10n ** 18n, state))
      .toThrow(/minimum/);
  });
});

describe("verified protection calls and estimates", () => {
  it("encodes the verified payable addColl hints and uses exact BTC value", async () => {
    const plan = await buildProtectPlan(owner, "add_collateral", "0.001", fakeAccess());
    const decoded = decodeFunctionData({
      abi: parseAbi(["function addColl(address _upperHint, address _lowerHint) payable"]),
      data: plan.calldata,
    });
    expect(decoded.functionName).toBe("addColl");
    expect(decoded.args).toEqual([owner, token]);
    expect(plan.value).toBe("0x38d7ea4c68000");
    expect(plan.target).toBe(borrowerOperations);
    expect(plan.estimatedGas).toBe("180000");
  });

  it("encodes exactly the repay amount and never creates an approval transaction", async () => {
    const plan = await buildProtectPlan(owner, "repay", "1.25", fakeAccess());
    const decoded = decodeFunctionData({
      abi: parseAbi(["function repayMUSD(uint256 _amount, address _upperHint, address _lowerHint)"]),
      data: plan.calldata,
    });
    expect(decoded.functionName).toBe("repayMUSD");
    expect(decoded.args).toEqual([125n * 10n ** 16n, owner, token]);
    expect(plan.value).toBe("0x0");
    const transaction = protectWalletTransaction(plan, owner);
    expect(transaction.to).toBe(borrowerOperations);
    expect(transaction.data).toBe(plan.calldata);
    expect(transaction.data.slice(0, 10)).not.toBe("0x095ea7b3");
  });

  it("recomputes before and after LTV and liquidation metrics", async () => {
    const plan = await buildProtectPlan(owner, "add_collateral", "1", fakeAccess());
    expect(plan.before.ltvPercent).toBeCloseTo(2.2);
    expect(plan.after.ltvPercent).toBeCloseTo(1.1);
    expect(plan.before.level).toBe("SAFE");
    expect(plan.after.level).toBe("SAFE");
    expect(plan.before.liquidationPriceUsd).toBeCloseTo(2_444.44, 1);
    expect(plan.after.liquidationPriceUsd).toBeCloseTo(1_222.22, 1);
    expect(calculateProtectMetrics(
      0n,
      0n,
      100_000n * 10n ** 18n,
      10n ** 18n,
      18,
    ).liquidationPriceUsd).toBeNull();
  });

  it("does not return a plan when contract simulation reverts", async () => {
    await expect(buildProtectPlan(owner, "repay", "1", fakeAccess({
      simulationError: { reason: "BorrowerOps: Trove's net debt must be greater than minimum" },
    }))).rejects.toThrow(/protocol minimum/);
  });

  it("maps verified revert reasons to plain language", () => {
    expect(mapProtectRevert({
      reason: "BorrowerOps: Caller doesnt have enough mUSD to make repayment",
    })).toMatch(/not have enough MUSD/);
    expect(mapProtectRevert(new Error("opaque rpc error"))).toMatch(/simulation rejected/);
  });

  it("computes target-LTV shortcuts for collateral and repayment", () => {
    expect(calculateTargetAmount("add_collateral", 1, 2000, 100_000, 1))
      .toBeCloseTo(1);
    expect(calculateTargetAmount("repay", 1, 2000, 100_000, 1))
      .toBeCloseTo(1000);
    expect(calculateTargetAmount("repay", 1, 100, 100_000, 1)).toBe(0);
  });
});

describe("wallet restrictions and network flow", () => {
  it("refuses a connected account that is not the trove owner", async () => {
    const wallet: EthereumProvider = {
      request: async () => ["0x0000000000000000000000000000000000000001"],
    };
    await expect(connectProtectedAccount(wallet, owner)).rejects.toThrow(/does not match the loan address/);
  });

  it("detects the wrong chain and offers add/switch only when called", async () => {
    const calls: string[] = [];
    let activeChain = "0x1";
    const wallet: EthereumProvider = {
      request: async ({ method, params }) => {
        calls.push(method);
        if (method === "eth_chainId") return activeChain;
        if (method === "wallet_switchEthereumChain" && activeChain === "0x1") {
          throw Object.assign(new Error("unknown chain"), { code: 4902 });
        }
        if (method === "wallet_addEthereumChain") {
          expect(params).toEqual([{
            chainId: `0x${(31611).toString(16)}`,
            chainName: "Mezo Testnet",
            rpcUrls: ["https://rpc.test.mezo.org"],
            nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
            blockExplorerUrls: ["https://explorer.test.mezo.org"],
          }]);
          activeChain = `0x${(31611).toString(16)}`;
          return null;
        }
        return null;
      },
    };
    expect(await isMezoTestnet(wallet)).toBe(false);
    expect(calls).toEqual(["eth_chainId"]);
    await switchToMezoTestnet(wallet);
    expect(calls).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(await isMezoTestnet(wallet)).toBe(true);
  });

  it("converts user rejection to a friendly message", () => {
    expect(walletErrorMessage(Object.assign(new Error("rejected"), { code: 4001 })))
      .toMatch(/rejected the request/);
  });
});

it("uses the wallet's user-approved chain call rather than handling keys", async () => {
  const plan = await buildProtectPlan(owner, "repay", "1", fakeAccess());
  const transaction = protectWalletTransaction(plan, owner);
  expect(transaction.from).toBe(owner);
  expect(transaction.chainId).toBe(`0x${(31611).toString(16)}`);
  expect(transaction.data).toBe(plan.calldata);
  expect(transaction.value).toBe("0x0");
  expect(Object.keys(transaction)).not.toContain("privateKey");
  expect(plan.action).toBe("repay");
});
