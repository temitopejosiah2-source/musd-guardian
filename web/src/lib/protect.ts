import {
  decodeErrorResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseAbi,
  parseUnits,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
} from "viem";
import {
  MUSD_ADDRESS,
  PRICE_FEED_ADDRESS,
  TROVE_MANAGER_ADDRESS,
  getThresholds,
  publicClient,
} from "./server";
import { calculateLtv, classifyLevel, liquidationPrice, type HealthLevel } from "./format";
import { bufferPercent } from "./risk";

export { calculateTargetAmount } from "./protect-math";

export type ProtectAction = "add_collateral" | "repay";

export interface ProtectMetrics {
  ltvPercent: number;
  level: HealthLevel;
  liquidationPriceUsd: number | null;
  bufferToLiquidationPercent: number | null;
}

export interface ProtectPlan {
  address: Address;
  action: ProtectAction;
  amount: string;
  target: Address;
  function: "addColl" | "repayMUSD";
  calldata: Hex;
  value: Hex;
  chainId: 31611;
  estimatedGas: string | null;
  estimatedFeeWei: string | null;
  before: ProtectMetrics;
  after: ProtectMetrics;
  warnings: string[];
}

export class ProtectPlanError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ProtectState {
  collateral: bigint;
  debt: bigint;
  status: number;
  principal: bigint;
  interestOwed: bigint;
  price: bigint;
  pricePrecision: bigint;
  musdDecimals: number;
  musdBalance: bigint;
  nativeBalance: bigint;
  minimumNetDebt: bigint;
  minimumNetDebtFloor: bigint;
  gasCompensation: bigint;
  borrowerOperations: Address;
  musdToken: Address;
  sortedTroves: Address;
}

export interface ProtectAccess {
  readState(address: Address): Promise<ProtectState>;
  findInsertPosition(sortedTroves: Address, nominalCollateralRatio: bigint): Promise<[Address, Address]>;
  simulate(transaction: { account: Address; to: Address; data: Hex; value: bigint }): Promise<void>;
  estimateGas(transaction: { account: Address; to: Address; data: Hex; value: bigint }): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
}

const borrowerOperationsAbi = parseAbi([
  "function addColl(address _upperHint, address _lowerHint) payable",
  "function repayMUSD(uint256 _amount, address _upperHint, address _lowerHint)",
  "function minNetDebt() view returns (uint256)",
  "function MIN_NET_DEBT_MIN() view returns (uint256)",
  "function MUSD_GAS_COMPENSATION() view returns (uint256)",
  "function musd() view returns (address)",
  "function sortedTroves() view returns (address)",
]);
const troveManagerAbi = parseAbi([
  "function getTroveColl(address _borrower) view returns (uint256)",
  "function getTroveDebt(address _borrower) view returns (uint256)",
  "function getTroveStatus(address _borrower) view returns (uint8)",
  "function getTrovePrincipal(address _borrower) view returns (uint256)",
  "function getTroveInterestOwed(address _borrower) view returns (uint256)",
  "function DECIMAL_PRECISION() view returns (uint256)",
]);
const priceFeedAbi = parseAbi(["function fetchPrice() view returns (uint256)"]);
const musdAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);
const sortedTrovesAbi = parseAbi([
  "function findInsertPosition(uint256 _NICR, address _prevId, address _nextId) view returns (address, address)",
]);
const standardRevertAbi = parseAbi(["error Error(string)", "error Panic(uint256)"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_DECIMALS = 18;
const NICR_PRECISION = 10n ** 20n;

export function parseProtectAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || value.length > 40) {
    throw new ProtectPlanError("Enter a positive decimal amount with a valid number of decimal places.", 400);
  }
  const parts = value.split(".");
  if (
    parts.length > 2 ||
    !parts[0] || !/^[0-9]+$/.test(parts[0]) ||
    (parts.length === 2 && (!parts[1] || !/^[0-9]+$/.test(parts[1])))
  ) {
    throw new ProtectPlanError("Enter a positive decimal amount with a valid number of decimal places.", 400);
  }
  const fraction = parts[1] ?? "";
  if (fraction.length > decimals) {
    throw new ProtectPlanError(`This token allows at most ${decimals} decimal places.`, 400);
  }
  let amount: bigint;
  try {
    amount = parseUnits(value, decimals);
  } catch {
    throw new ProtectPlanError("Enter a valid positive decimal amount.", 400);
  }
  if (amount <= 0n) {
    throw new ProtectPlanError("Amount must be greater than zero.", 400);
  }
  return amount;
}

export function enforceProtectLimits(
  action: ProtectAction,
  amount: bigint,
  state: Pick<ProtectState, "nativeBalance" | "musdBalance" | "debt" | "minimumNetDebt" | "gasCompensation">,
): void {
  if (action === "add_collateral") {
    if (amount > state.nativeBalance) {
      throw new ProtectPlanError("Your BTC balance is too low for this collateral amount.", 400);
    }
    return;
  }

  if (amount > state.musdBalance) {
    throw new ProtectPlanError("Your MUSD balance is too low for this repayment amount.", 400);
  }
  const netDebt = state.debt - state.gasCompensation;
  if (amount > netDebt) {
    throw new ProtectPlanError("Repayment cannot exceed the trove's net debt.", 400);
  }
  if (netDebt - amount < state.minimumNetDebt) {
    throw new ProtectPlanError(
      `Repayment would leave net debt below the current ${formatUnits(state.minimumNetDebt, 18)} MUSD minimum.`,
      400,
    );
  }
}

export function calculateProtectMetrics(
  collateral: bigint,
  debt: bigint,
  price: bigint,
  pricePrecision: bigint,
  musdDecimals: number,
): ProtectMetrics {
  const collateralBtc = Number(formatUnits(collateral, NATIVE_DECIMALS));
  const debtMusd = Number(formatUnits(debt, musdDecimals));
  const btcPrice = Number(formatUnits(price, decimalPlaces(pricePrecision)));
  const ltvPercent = calculateLtv(debtMusd, collateralBtc, btcPrice);
  const liquidationPriceUsd = liquidationPrice(debtMusd, collateralBtc, 90);
  return {
    ltvPercent,
    level: classifyLevel(
      { collateralBtc, debtMusd, btcPriceUsd: btcPrice, troveActive: collateral > 0n },
      getThresholds().monitor,
      getThresholds().warn,
      getThresholds().danger,
    ),
    liquidationPriceUsd,
    bufferToLiquidationPercent: liquidationPriceUsd === null
      ? null
      : bufferPercent(btcPrice, liquidationPriceUsd),
  };
}

export async function buildProtectPlan(
  address: Address,
  action: ProtectAction,
  amountText: string,
  access: ProtectAccess = rpcProtectAccess,
): Promise<ProtectPlan> {
  const owner = getAddress(address);
  const state = await access.readState(owner);
  if (state.status !== 1 || state.collateral <= 0n) {
    throw new ProtectPlanError("This address does not have an active trove.", 409);
  }

  const decimals = action === "add_collateral" ? NATIVE_DECIMALS : state.musdDecimals;
  const amount = parseProtectAmount(amountText, decimals);
  enforceProtectLimits(action, amount, state);

  const collateralAfter = action === "add_collateral" ? state.collateral + amount : state.collateral;
  const debtAfter = action === "repay" ? state.debt - amount : state.debt;
  const principalReduction = action === "repay" && amount > state.interestOwed
    ? amount - state.interestOwed
    : 0n;
  const principalAfter = state.principal - principalReduction;
  if (principalAfter <= 0n) {
    throw new ProtectPlanError("The repayment amount cannot be safely represented for trove sorting.", 400);
  }

  const nominalCollateralRatio = collateralAfter * NICR_PRECISION / principalAfter;
  const [upperHint, lowerHint] = await access.findInsertPosition(
    state.sortedTroves,
    nominalCollateralRatio,
  );
  const value = action === "add_collateral" ? amount : 0n;
  const functionName = action === "add_collateral" ? "addColl" : "repayMUSD";
  const calldata = action === "add_collateral"
    ? encodeFunctionData({
        abi: borrowerOperationsAbi,
        functionName: "addColl",
        args: [upperHint, lowerHint],
      })
    : encodeFunctionData({
        abi: borrowerOperationsAbi,
        functionName: "repayMUSD",
        args: [amount, upperHint, lowerHint],
      });
  const transaction = {
    account: owner,
    to: state.borrowerOperations,
    data: calldata,
    value,
  };

  try {
    await access.simulate(transaction);
  } catch (error) {
    if (isContractRevert(error)) {
      throw new ProtectPlanError(mapProtectRevert(error), 422);
    }
    throw error;
  }

  const metricsBefore = calculateProtectMetrics(
    state.collateral,
    state.debt,
    state.price,
    state.pricePrecision,
    state.musdDecimals,
  );
  const metricsAfter = calculateProtectMetrics(
    collateralAfter,
    debtAfter,
    state.price,
    state.pricePrecision,
    state.musdDecimals,
  );
  const warnings = ["This is Mezo TESTNET. On-chain state and fee estimates can change before confirmation."];
  let estimatedGas: string | null = null;
  let estimatedFeeWei: string | null = null;
  try {
    const gas = await access.estimateGas(transaction);
    estimatedGas = gas.toString();
    estimatedFeeWei = (gas * await access.getGasPrice()).toString();
  } catch {
    warnings.push("Gas estimation was unavailable. Review the fee in your wallet before signing.");
  }

  return {
    address: owner,
    action,
    amount: formatUnits(amount, decimals),
    target: state.borrowerOperations,
    function: functionName,
    calldata,
    value: `0x${value.toString(16)}`,
    chainId: 31611,
    estimatedGas,
    estimatedFeeWei,
    before: metricsBefore,
    after: metricsAfter,
    warnings,
  };
}

export function mapProtectRevert(error: unknown): string {
  const reason = findRevertReason(error);
  const normalized = reason?.toLowerCase() ?? "";
  if (normalized.includes("minimum") || normalized.includes("min net debt")) {
    return "That repayment would leave less debt than the protocol minimum. Choose a smaller amount.";
  }
  if (normalized.includes("enough musd") || normalized.includes("balance")) {
    return "The wallet does not have enough MUSD for this repayment.";
  }
  if (normalized.includes("larger than the trove") || normalized.includes("debt repayment")) {
    return "The repayment exceeds the amount that can be repaid while keeping the trove open.";
  }
  if (normalized.includes("trove") && (normalized.includes("active") || normalized.includes("does not exist"))) {
    return "This address no longer has an active trove.";
  }
  if (normalized.includes("recovery mode")) {
    return "The protocol’s current recovery-mode rules do not allow this change.";
  }
  if (normalized.includes("insufficient funds")) {
    return "The wallet does not have enough BTC to cover the collateral and network fee.";
  }
  return "The protocol simulation rejected this change. No transaction was offered; refresh the loan data and review the amount.";
}

function findRevertReason(error: unknown): string | undefined {
  let current: unknown = error;
  const visited = new Set<object>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("reason" in current && typeof current.reason === "string") return current.reason;
    if ("data" in current && typeof current.data === "string" && current.data.startsWith("0x")) {
      try {
        const decoded = decodeErrorResult({ abi: standardRevertAbi, data: current.data as Hex });
        if (decoded.errorName === "Error" && typeof decoded.args[0] === "string") {
          return decoded.args[0];
        }
        if (decoded.errorName === "Panic") return "The contract encountered an arithmetic panic.";
      } catch {
        // The revert may belong to a nested protocol contract with another error ABI.
      }
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return typeof error === "string" ? error : undefined;
}

function isContractRevert(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<object>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      current instanceof ContractFunctionRevertedError ||
      ("reason" in current && typeof current.reason === "string")
    ) return true;
    if ("data" in current && typeof current.data === "string" &&
      /^0x(?:08c379a0|4e487b71|[0-9a-f]{8})/i.test(current.data)) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

const rpcProtectAccess: ProtectAccess = {
  async readState(address) {
    const [collateral, debt, status, principal, interestOwed, price, pricePrecision,
      musdDecimals, musdBalance, nativeBalance, minimumNetDebt, minimumNetDebtFloor,
      gasCompensation, musdToken, sortedTroves] = await Promise.all([
      publicClient.readContract({
        address: TROVE_MANAGER_ADDRESS,
        abi: troveManagerAbi,
        functionName: "getTroveColl",
        args: [address],
      }),
      publicClient.readContract({
        address: TROVE_MANAGER_ADDRESS,
        abi: troveManagerAbi,
        functionName: "getTroveDebt",
        args: [address],
      }),
      publicClient.readContract({
        address: TROVE_MANAGER_ADDRESS,
        abi: troveManagerAbi,
        functionName: "getTroveStatus",
        args: [address],
      }),
      publicClient.readContract({
        address: TROVE_MANAGER_ADDRESS,
        abi: troveManagerAbi,
        functionName: "getTrovePrincipal",
        args: [address],
      }),
      publicClient.readContract({
        address: TROVE_MANAGER_ADDRESS,
        abi: troveManagerAbi,
        functionName: "getTroveInterestOwed",
        args: [address],
      }),
      publicClient.readContract({
        address: PRICE_FEED_ADDRESS,
        abi: priceFeedAbi,
        functionName: "fetchPrice",
      }),
      publicClient.readContract({
        address: TROVE_MANAGER_ADDRESS,
        abi: troveManagerAbi,
        functionName: "DECIMAL_PRECISION",
      }),
      publicClient.readContract({
        address: MUSD_ADDRESS,
        abi: musdAbi,
        functionName: "decimals",
      }),
      publicClient.readContract({
        address: MUSD_ADDRESS,
        abi: musdAbi,
        functionName: "balanceOf",
        args: [address],
      }),
      publicClient.getBalance({ address }),
      publicClient.readContract({
        address: BORROWER_OPERATIONS_ADDRESS,
        abi: borrowerOperationsAbi,
        functionName: "minNetDebt",
      }),
      publicClient.readContract({
        address: BORROWER_OPERATIONS_ADDRESS,
        abi: borrowerOperationsAbi,
        functionName: "MIN_NET_DEBT_MIN",
      }),
      publicClient.readContract({
        address: BORROWER_OPERATIONS_ADDRESS,
        abi: borrowerOperationsAbi,
        functionName: "MUSD_GAS_COMPENSATION",
      }),
      publicClient.readContract({
        address: BORROWER_OPERATIONS_ADDRESS,
        abi: borrowerOperationsAbi,
        functionName: "musd",
      }),
      publicClient.readContract({
        address: BORROWER_OPERATIONS_ADDRESS,
        abi: borrowerOperationsAbi,
        functionName: "sortedTroves",
      }),
    ]);

    if (getAddress(musdToken) !== MUSD_ADDRESS) {
      throw new ProtectPlanError("The deployed MUSD contract does not match the verified testnet configuration.", 503);
    }
    if (minimumNetDebt < minimumNetDebtFloor) {
      throw new ProtectPlanError("The protocol returned invalid minimum-debt settings.", 503);
    }
    return {
      collateral,
      debt,
      status: Number(status),
      principal,
      interestOwed,
      price,
      pricePrecision,
      musdDecimals: Number(musdDecimals),
      musdBalance,
      nativeBalance,
      minimumNetDebt,
      minimumNetDebtFloor,
      gasCompensation,
      borrowerOperations: BORROWER_OPERATIONS_ADDRESS,
      musdToken: MUSD_ADDRESS,
      sortedTroves: getAddress(sortedTroves),
    };
  },
  async findInsertPosition(sortedTroves, nominalCollateralRatio) {
    const result = await publicClient.readContract({
      address: sortedTroves,
      abi: sortedTrovesAbi,
      functionName: "findInsertPosition",
      args: [nominalCollateralRatio, ZERO_ADDRESS, ZERO_ADDRESS],
    });
    return [getAddress(result[0]), getAddress(result[1])];
  },
  async simulate({ account, to, data, value }) {
    await publicClient.call({ account, to, data, value });
  },
  estimateGas({ account, to, data, value }) {
    return publicClient.estimateGas({ account, to, data, value });
  },
  getGasPrice() {
    return publicClient.getGasPrice();
  },
};

const BORROWER_OPERATIONS_ADDRESS = "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5" as Address;

function decimalPlaces(precision: bigint): number {
  if (precision <= 0n) throw new ProtectPlanError("The testnet price precision is invalid.", 503);
  let value = precision;
  let places = 0;
  while (value % 10n === 0n) {
    value /= 10n;
    places += 1;
  }
  if (value !== 1n) throw new ProtectPlanError("The testnet price precision is invalid.", 503);
  return places;
}
