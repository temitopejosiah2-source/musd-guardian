import "dotenv/config";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  type Abi,
  type AbiFunction,
  type Address,
} from "viem";
import { publicClient } from "./client.js";
import { EXPLORER_URL } from "./config.js";
import { writeFile } from "node:fs/promises";
import {
  fetchWithTimeout,
  logError,
  logInfo,
  readBoundedJson,
  readBoundedText,
} from "./security.js";
import { validateEnvironment } from "./env.js";

const TROVE_TRANSACTION =
  "0x3ef7f0ce860647e798f7f8e3b9c4146ba36aad69238e46b37098e0bbf8b075f1";
const DISCOVERY_FILE = "discovery.json";
const MAX_CONTRACTS = 30;

type JsonObject = Record<string, unknown>;
type FunctionCandidate = {
  signature: string;
  reason: string;
};
type DiscoveredContract = {
  address: Address;
  discoveredAs: string;
  name: string;
  verified: boolean;
  proxyImplementations: Array<{ address: Address; name: string | null }>;
  abiSource: string;
  abi: Abi;
  proxyAbi?: Abi;
  functions: string[];
  addressViews: Array<{ function: string; address: Address }>;
  candidates: FunctionCandidate[];
  readErrors: Array<{ function: string; message: string }>;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) throw new Error("response was not JSON");
  return readBoundedJson(response, 2 * 1024 * 1024);
}

async function getApiBase(): Promise<string> {
  const response = await fetchWithTimeout(`${EXPLORER_URL}/assets/envs.js`);
  if (!response.ok) {
    throw new Error(`Could not read explorer API configuration (HTTP ${response.status})`);
  }
  const config = await readBoundedText(response, 256 * 1024);
  const match = config.match(/NEXT_PUBLIC_API_HOST:\s*"([^"]+)"/);
  if (!match) throw new Error("Explorer API host is missing from its public configuration");
  const protocol = config.match(/NEXT_PUBLIC_API_PROTOCOL:\s*"([^"]+)"/)?.[1] ?? "https";
  return `${protocol}://${match[1]}`;
}

async function getAbi(address: Address, apiBase: string): Promise<{
  abi: Abi;
  source: string;
}> {
  const modernUrls = [
    `${EXPLORER_URL}/api/v2/smart-contracts/${address}`,
    `${apiBase}/api/v2/smart-contracts/${address}`,
  ];
  const errors: string[] = [];

  for (const url of modernUrls) {
    try {
      const payload = await fetchJson(url);
      if (!isObject(payload) || !Array.isArray(payload.abi)) {
        throw new Error("verified ABI is absent");
      }
      return { abi: payload.abi as Abi, source: url };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }

  for (const base of [EXPLORER_URL, apiBase]) {
    const url = new URL(`${base}/api`);
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getabi");
    url.searchParams.set("address", address);
    try {
      const payload = await fetchJson(url.toString());
      if (
        !isObject(payload) ||
        payload.status !== "1" ||
        typeof payload.result !== "string"
      ) {
        throw new Error("legacy endpoint did not return a verified ABI");
      }
      return { abi: JSON.parse(payload.result) as Abi, source: url.toString() };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }

  throw new Error(`Could not fetch a verified ABI for ${address}: ${errors.join("; ")}`);
}

async function getImplementations(
  address: Address,
  apiBase: string,
): Promise<Array<{ address: Address; name: string | null }>> {
  for (const base of [EXPLORER_URL, apiBase]) {
    try {
      const payload = await fetchJson(`${base}/api/v2/addresses/${address}`);
      if (!isObject(payload) || !Array.isArray(payload.implementations)) continue;
      return payload.implementations.flatMap((item) => {
        if (!isObject(item) || typeof item.address !== "string" || !isAddress(item.address)) {
          return [];
        }
        return [{
          address: getAddress(item.address),
          name: typeof item.name === "string" ? item.name : null,
        }];
      });
    } catch {
      // Try the explorer's API host after the public site host.
    }
  }
  return [];
}

function functionSignature(fn: AbiFunction): string {
  const inputs = fn.inputs.map((input) => `${input.type} ${input.name ?? ""}`.trim()).join(", ");
  const outputs = fn.outputs?.map((output) => `${output.type} ${output.name ?? ""}`.trim()).join(", ") ?? "";
  return `${fn.name}(${inputs})${outputs ? ` returns (${outputs})` : ""} [${fn.stateMutability}]`;
}

function abiFunctions(abi: Abi): AbiFunction[] {
  return abi.filter((entry): entry is AbiFunction => entry.type === "function");
}

function classifyCandidate(fn: AbiFunction): string[] {
  if (fn.stateMutability !== "view" && fn.stateMutability !== "pure") return [];
  const signature = functionSignature(fn).toLowerCase();
  const hasAddressInput = fn.inputs.some((input) => input.type === "address");
  const reasons: string[] = [];
  if (hasAddressInput && /(collateral|debt|trove|ratio|status|icr|tcr)/.test(signature)) {
    reasons.push("borrower-address view possibly returning trove collateral, debt, ratio, or status");
  }
  if (/(price|fetchprice|btc|bitcoin)/.test(signature) && fn.outputs.length > 0) {
    reasons.push("possible BTC price view");
  }
  return reasons;
}

async function addressViewResults(
  contractAddress: Address,
  abi: Abi,
  record: DiscoveredContract,
): Promise<void> {
  for (const fn of abiFunctions(abi)) {
    if (
      fn.inputs.length !== 0 ||
      fn.outputs.length !== 1 ||
      fn.outputs[0]?.type !== "address" ||
      (fn.stateMutability !== "view" && fn.stateMutability !== "pure")
    ) {
      continue;
    }
    try {
      const data = encodeFunctionData({
        abi,
        functionName: fn.name,
        args: [],
      });
      const result = await publicClient.call({ to: contractAddress, data });
      if (!result.data) throw new Error("empty return data");
      const decoded = decodeFunctionResult({
        abi,
        functionName: fn.name,
        data: result.data,
      });
      if (typeof decoded !== "string" || !isAddress(decoded)) {
        throw new Error("return value is not an address");
      }
      const address = getAddress(decoded);
      record.addressViews.push({ function: fn.name, address });
      logInfo(`  ${fn.name}() -> ${address}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "call failed";
      record.readErrors.push({ function: fn.name, message });
      logInfo(`  ${fn.name}() -> ERROR: ${message}`);
    }
  }
}

async function discoverContract(
  address: Address,
  discoveredAs: string,
  apiBase: string,
): Promise<DiscoveredContract> {
  const proxyAbiResult = await getAbi(address, apiBase);
  const implementations = await getImplementations(address, apiBase);
  let abi = proxyAbiResult.abi;
  let abiSource = proxyAbiResult.source;
  let name = discoveredAs;
  let verified = true;

  if (implementations.length > 0) {
    const implementation = implementations[0];
    if (!implementation) throw new Error("Missing implementation details");
    const result = await getAbi(implementation.address, apiBase);
    abi = result.abi;
    abiSource = result.source;
    name = implementation.name ?? discoveredAs;
  } else {
    const payload = await fetchJson(proxyAbiResult.source);
    if (isObject(payload)) {
      if (typeof payload.name === "string") name = payload.name;
      if (typeof payload.is_verified === "boolean") verified = payload.is_verified;
    }
  }

  const functions = abiFunctions(abi);
  const candidates = functions.flatMap((fn) =>
    classifyCandidate(fn).map((reason) => ({ signature: functionSignature(fn), reason })),
  );
  return {
    address,
    discoveredAs,
    name,
    verified,
    proxyImplementations: implementations,
    abiSource,
    abi,
    ...(implementations.length > 0 ? { proxyAbi: proxyAbiResult.abi } : {}),
    functions: functions.map(functionSignature),
    addressViews: [],
    candidates,
    readErrors: [],
  };
}

async function main(): Promise<void> {
  validateEnvironment();
  const apiBase = await getApiBase();
  const tx = await publicClient.getTransaction({ hash: TROVE_TRANSACTION });
  if (!tx.to) throw new Error("The supplied trove transaction has no destination contract");

  const rootAddress = getAddress(tx.to);
  logInfo(`Transaction: ${TROVE_TRANSACTION}`);
  logInfo(`BorrowerOperations destination: ${rootAddress}`);
  logInfo(`Transaction value: ${tx.value.toString()} wei`);
  logInfo(`Explorer API host: ${apiBase}`);

  const records: DiscoveredContract[] = [];
  const seen = new Set<string>();
  const queue: Array<{ address: Address; label: string; depth: number }> = [
    { address: rootAddress, label: "BorrowerOperations", depth: 0 },
  ];

  while (queue.length > 0 && records.length < MAX_CONTRACTS) {
    const current = queue.shift();
    if (!current) break;
    const key = current.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    logInfo(`\nContract ${current.label}: ${current.address}`);
    let record: DiscoveredContract;
    try {
      record = await discoverContract(current.address, current.label, apiBase);
    } catch (error) {
      logError(`  ABI discovery failed: ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    records.push(record);
    if (record.proxyImplementations.length > 0) {
      logInfo(`  Proxy implementation: ${record.proxyImplementations[0]?.address}`);
    }
    logInfo(`  ABI source: ${record.abiSource}`);
    logInfo("  Functions:");
    for (const signature of record.functions) logInfo(`    ${signature}`);

    if (current.depth < 2) {
      logInfo("  No-argument view functions returning address:");
      await addressViewResults(current.address, record.abi, record);
      for (const result of record.addressViews) {
        if (
          /(trove.?manager|price.?feed|sorted.?troves)/i.test(result.function) &&
          !seen.has(result.address.toLowerCase())
        ) {
          queue.push({
            address: result.address,
            label: record.addressViews.find((entry) => entry.address === result.address)?.function ?? "discovered dependency",
            depth: current.depth + 1,
          });
        }
      }
    }
  }

  logInfo("\nCandidate health and price views:");
  for (const contract of records) {
    logInfo(`  ${contract.name} at ${contract.address}`);
    const views = abiFunctions(contract.abi).filter(
      (fn) => fn.stateMutability === "view" || fn.stateMutability === "pure",
    );
    for (const fn of views) logInfo(`    ${functionSignature(fn)}`);
    for (const candidate of contract.candidates) {
      logInfo(`    CANDIDATE: ${candidate.signature} — ${candidate.reason}`);
    }
  }

  await writeFile(
    DISCOVERY_FILE,
    `${JSON.stringify(
      { transaction: TROVE_TRANSACTION, borrowerOperations: rootAddress, apiBase, contracts: records },
      (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  logInfo(`\nDiscovery details saved to ${DISCOVERY_FILE}.`);

  const readableTroveFunctions = records.flatMap((contract) =>
    contract.candidates.filter((candidate) =>
      /(collateral|debt|trove|ratio|status|icr|tcr)/i.test(candidate.signature),
    ),
  );
  if (readableTroveFunctions.length === 0) {
    logError(
      "STOP: no ABI candidate taking a borrower address and exposing trove collateral, debt, ratio, or status was found. Health implementation is not safe to guess.",
    );
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  logError(`Discovery failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
