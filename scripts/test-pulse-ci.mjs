import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
// This separate, opt-in Anvil differential campaign is not a mocked CI suite.
// Run it with test:pulse:c5:evm. The ordinary CI job still runs all Foundry tests.
export const LOCAL_EVM_SUITES = Object.freeze(['pulse-contract-review.node-test.mjs']);

/** Discover new Pulse suites automatically; never silently pin an old file list. */
export function discoverPulseMockSuites(names = readdirSync(resolve(ROOT, 'contracts/tools'))) {
  return names.filter(name => /^pulse-[a-z0-9-]+\.node-test\.mjs$/.test(name) &&
    !LOCAL_EVM_SUITES.includes(name)).sort();
}

export function pulseCiArguments(names) {
  const suites = discoverPulseMockSuites(names);
  assert.ok(suites.length > 0, 'No mocked Pulse regression suites were discovered');
  return ['--import', 'tsx', '--test', '--test-concurrency=4',
    ...suites.map(name => `contracts/tools/${name}`)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--list',
    'Usage: node scripts/test-pulse-ci.mjs [--list]');
  if (process.argv[2] === '--list') {
    console.log(JSON.stringify({ selected: discoverPulseMockSuites(), separateLocalEvm: LOCAL_EVM_SUITES }, null, 2));
  } else {
    // No .env loader, live RPC endpoint, wallet custody or provider API is used.
    // OPEN_MINT_TEST_POSTGRES opts the existing relay fixture into a NEW cluster;
    // it cannot accept a DATABASE_URL or the active site's data directory.
    const result = spawnSync(process.execPath, pulseCiArguments(), { cwd: ROOT, env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
