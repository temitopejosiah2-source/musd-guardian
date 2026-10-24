import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowedPublicNames = new Set([
  "NEXT_PUBLIC_TELEGRAM_BOT_URL",
  "NEXT_PUBLIC_REPO_URL",
]);
const secretValuePatterns = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /(?:sk|pk|rk|key|token|secret)[_-][A-Za-z0-9_-]{16,}/i,
  /\b0x[0-9a-fA-F]{64,}\b/,
  /(?:[?&]|\b)(?:api[_-]?key|token|secret|password)=/i,
];
const findings = new Set();

for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("NEXT_PUBLIC_")) inspect(name, value ?? "");
}

// The scanned directory is the fixed web project root, not user input.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- root is derived from this script's location.
for (const file of await readdir(root)) {
  if (!file.startsWith(".env") || file === ".env.example") continue;
  let contents;
  try {
    // `file` comes from readdir(root) and is restricted to .env* names.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- only immediate .env files in the fixed project root are read.
    contents = await readFile(resolve(root, file), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw new Error(`Unable to inspect ${file} for unsafe public variables`);
  }
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().replace(/^export\s+/, "");
    if (!/^NEXT_PUBLIC_[A-Za-z0-9_]+$/.test(name)) continue;
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    inspect(name, value);
  }
}

function inspect(name, value) {
  if (!allowedPublicNames.has(name)) {
    findings.add(name);
    return;
  }
  if (secretValuePatterns.some((pattern) => pattern.test(value))) findings.add(name);
}

if (findings.size > 0) {
  console.error(
    `Unsafe NEXT_PUBLIC_ configuration found for: ${[...findings].sort().join(", ")}`,
  );
  process.exitCode = 1;
} else {
  console.log("NEXT_PUBLIC_ environment check passed.");
}
