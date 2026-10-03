import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIR, loadAdminPlan, loadAdminJournal } from './pulse-sepolia-admin.mjs';
import { startSepoliaTestSite } from './pulse-sepolia-site.mjs';
import { verifyPulseAdminDeployment } from './pulse-sepolia-admin-verify.mjs';
import { readFailureDiagnostic } from './pulse-sepolia-recovery.mjs';
import { rpcTransport, retrySafeReads, boundedReadSource } from './pulse-sepolia.mjs';
import { requireRpcData, unavailableRpcData } from './pulse-sepolia-rpc.mjs';
import { parseSiteLaunchMode } from './pulse-site-launch.mjs';

export async function verifyFinalizedAdminBinding(c, p, j, verify = verifyPulseAdminDeployment) {
  const finalized = requireRpcData(await c.rpc('eth_getBlockByNumber', ['finalized', false]));
  if (BigInt(requireRpcData(finalized.number)) < BigInt(requireRpcData(j.transactions.collection.receipt).blockNumber))
    throw unavailableRpcData();
  const binding = (await verify(c, p, j)).binding;
  if (!binding.deployment.finalized) throw unavailableRpcData();
  return binding;
}

/** Separate origin/run directory preserves RC1 browser attempts and evidence.
 * Only the unfunded authorizer is loaded by the site, never the admin keystore.
 * Existing relay schema supports independently pinned deployment IDs. */
export async function startAdminSepoliaSite(port = 3007) {
  assert.notEqual(process.env.NODE_ENV, 'production');
  const siteLaunchMode = parseSiteLaunchMode(process.env.PULSE_SITE_LAUNCH_MODE ?? 'open');
  const plan = loadAdminPlan(), journal = loadAdminJournal(DIR, plan);
  if (!process.env.PULSE_RELAY_DATABASE_URL) {
    const socket = resolve(DIR, '../pulse-relay/socket');
    assert.ok(existsSync(socket), 'Start the dedicated local relay PostgreSQL cluster first.');
    const connection = new URL('postgresql:///sg_pulse_relay');
    connection.searchParams.set('host', socket); connection.searchParams.set('user', 'sg_pulse_relay');
    connection.searchParams.set('connect_timeout', '3'); process.env.PULSE_RELAY_DATABASE_URL = connection.href;
  }
  const primary = new URL(process.env.SEPOLIA_ADMIN_RPC_URL ?? 'https://sepolia.gateway.tenderly.co');
  const secondary = new URL(process.env.SEPOLIA_ADMIN_SECONDARY_RPC_URL ?? 'https://eth-sepolia.api.onfinality.io/public');
  assert.equal(primary.protocol, 'https:'); assert.equal(secondary.protocol, 'https:');
  assert.notEqual(primary.hostname, secondary.hostname);
  const context = { rpc: retrySafeReads(boundedReadSource(rpcTransport(primary.href))),
    second: retrySafeReads(boundedReadSource(rpcTransport(secondary.href))) };
  return startSepoliaTestSite(port, { plan, journal, directory: DIR, context, adminWeb: true, siteLaunchMode,
    // A pending CREATE is expected, not a permanently blocked assertion lane.
    verifyDeployment: verifyFinalizedAdminBinding,
    allowlistProvider: () => {
      const config = JSON.parse(readFileSync(resolve(DIR, 'free-config.json'), 'utf8'));
      assert.equal(config.planDigest, plan.digest); assert.equal(config.contract, plan.collection.address);
      return config.allowlist;
    } });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startAdminSepoliaSite(Number(process.env.PORT ?? 3007)).then(site => {
    let closing = false;
    const stop = async () => {
      if (closing) return; closing = true;
      try { await site.close(); process.exitCode = 0; }
      catch { process.exitCode = 1; }
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(error => {
    console.error('Sepolia free-mint site refused startup; credentials suppressed.');
    console.error(JSON.stringify(readFailureDiagnostic(error))); process.exitCode = 1;
  });
}
