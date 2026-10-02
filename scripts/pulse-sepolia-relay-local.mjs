import assert from 'node:assert/strict';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startSepoliaTestSite } from './pulse-sepolia-site.mjs';
import { readFailureDiagnostic } from './pulse-sepolia-recovery.mjs';

// This dedicated socket-only cluster never touches .local/rehearsal.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../.local/pulse-relay');
const data = resolve(root, 'data'), socket = resolve(root, 'socket');
assert.notEqual(process.env.NODE_ENV, 'production', 'Local relay launcher is not a production supervisor.');
assert.ok(existsSync(resolve(data, 'PG_VERSION')), 'Provision the dedicated local relay database first; see docs/pulse-site-relay.md.');
mkdirSync(socket, { recursive: true, mode: 0o700 });
chmodSync(socket, 0o700);
const pgCtl = process.env.PULSE_RELAY_PG_CTL ?? 'pg_ctl';
let running = true;
try { execFileSync(pgCtl, ['-D', data, 'status'], { stdio: 'ignore' }); }
catch { running = false; }
if (!running) execFileSync(pgCtl, ['-D', data, '-l', resolve(root, 'postgres.log'),
  '-o', `-h '' -k ${socket} -c listen_addresses='' -c unix_socket_permissions=0700`,
  '-t', '15', 'start', '-w'], { stdio: 'inherit' });

const connection = new URL('postgresql:///sg_pulse_relay');
connection.searchParams.set('host', socket);
connection.searchParams.set('user', 'sg_pulse_relay');
connection.searchParams.set('connect_timeout', '3');
process.env.PULSE_RELAY_DATABASE_URL = connection.href;
// Explicit local read routing. The private deployment RPC remains unchanged;
// operators can override this when their preferred endpoint is reachable.
process.env.SEPOLIA_READ_RPC_URL ??= 'https://eth-sepolia.api.onfinality.io/public';
startSepoliaTestSite(Number(process.env.PORT ?? 3004)).catch(error => {
  console.error('Local Sepolia relay site refused startup. Inspect deployment, database, RPC and process-lock state; secret details suppressed.');
  console.error(JSON.stringify(readFailureDiagnostic(error)));
  process.exitCode = 1;
});
