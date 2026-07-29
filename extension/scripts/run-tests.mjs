/** Run every zero-cost unit/regression suite in a deterministic order. */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
  .filter((name) => /^test-.+\.mjs$/.test(name))
  .sort();

if (!tests.length) {
  console.error("No test-*.mjs suites found.");
  process.exit(1);
}

for (const test of tests) {
  const result = spawnSync(process.execPath, [join(here, test)], { stdio: "inherit" });
  if (result.error) {
    console.error(`Could not run ${test}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\n✓ ${tests.length} test suites passed`);
