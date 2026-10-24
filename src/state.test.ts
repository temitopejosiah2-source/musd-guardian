import assert from "node:assert/strict";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { after, test } from "node:test";
import { loadState, saveState } from "./state.js";

/* eslint security/detect-non-literal-fs-filename: "off" -- These paths are fixed test files scoped by the current process ID. */
const statePath = `.state-recovery-${process.pid}.json`;
const previousPath = process.env.STATE_PATH;
process.env.STATE_PATH = statePath;

after(async () => {
  if (previousPath === undefined) delete process.env.STATE_PATH;
  else process.env.STATE_PATH = previousPath;
  await Promise.all(
    [statePath, `${statePath}.bak`].map((path) =>
      rm(path, { force: true }),
    ),
  );
});

test("backs up a corrupted state file and starts clean", async () => {
  await saveState({ lastProcessedBlock: 12n, recentIds: ["valid"] });
  await writeFile(
    statePath,
    '{"lastProcessedBlock":"private-invalid-value","recentIds":[]}',
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(statePath, 0o600);

  const recovered = await loadState(99n);
  assert.equal(recovered.lastProcessedBlock, 99n);
  assert.deepEqual(recovered.recentIds, []);
  const backup = await readFile(`${statePath}.bak`, "utf8");
  assert.match(backup, /private-invalid-value/);
  const restored = await readFile(statePath, "utf8");
  assert.match(restored, /"lastProcessedBlock": "99"/);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(`${statePath}.bak`)).mode & 0o777, 0o600);
});
