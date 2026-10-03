import assert from 'node:assert/strict';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress } from 'viem';
import { PublicError } from '../src/openMint/security.ts';
import { parseSiteLaunchMode } from '../src/openMint/sitePhase.ts';

export { parseSiteLaunchMode };
export const SITE_LAUNCH_RECORD = 'site-launch.json';
const version = 'sg-pulse-site-launch-v1';
const refusal = () => new PublicError(409, 'SITE_ALREADY_OPEN', 'This website has already opened. Pre-launch mode cannot be restored.');

// This private operator record is not an on-chain phase or a mint quote. It
// prevents a later restart from presenting maintenance as a never-opened site.
function privateRead(path, optional = false, inspected) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= 4096 && (stat.mode & 0o077) === 0, 'Invalid private launch state.');
    inspected?.(stat);
    return readFileSync(fd, 'utf8');
  } catch (error) { if (optional && error?.code === 'ENOENT') return; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function bindingFor(plan) {
  assert.match(plan?.digest, /^(?:0x)?[a-f0-9]{64}$/i);
  const contractProfile = plan.contractProfile ?? 'generative-pulse-v1-rc1';
  assert.ok(typeof contractProfile === 'string' && contractProfile.length > 0 && contractProfile.length <= 100);
  return { planDigest: plan.digest, contractProfile, chainId: 11155111, collection: getAddress(plan.collection.address) };
}
export function hasKnownMintActivity(value) {
  const sale = value?.sale ?? value;
  return (value?.mints?.size ?? 0) > 0 || BigInt(sale?.freeMinted ?? 0) > 0n
    || BigInt(sale?.lastPaidMintBlock ?? 0) > 0n;
}
function openingRecord(plan, directory) {
  const binding = bindingFor(plan), raw = privateRead(resolve(directory, SITE_LAUNCH_RECORD), true);
  if (raw === undefined) return;
  const record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), ['binding', 'openedAt', 'version']);
  assert.equal(record.version, version); assert.deepEqual(record.binding, binding);
  assert.ok(Number.isSafeInteger(record.openedAt) && record.openedAt > 0);
  return record;
}
/** Read-only validation for an explicitly deployment-bound preview frontend. */
export function assertSitePrelaunchAllowed({ plan, directory, knownMintActivity = false }) {
  if (openingRecord(plan, directory) || knownMintActivity) throw refusal();
}
/** Never unlink another process's replacement lock during error cleanup. */
export function releaseOwnedSiteLock(path, identity) {
  try {
    let owned;
    const pid = privateRead(path, false, stat => { owned = stat.dev === identity?.dev && stat.ino === identity?.ino; });
    if (!owned || pid !== String(process.pid)) return false;
    unlinkSync(path); return true;
  } catch { return false; }
}

/** Caller holds this deployment directory's existing exclusive process lock.
 * Construction validates; activation persists only after the listener binds.
 * The explicit mode is immutable for the process; opening requires a restart.
 */
export function createSiteLaunchGate({ mode = 'open', plan, directory, knownMintActivity = false, now = Date.now, lockIdentity }) {
  mode = parseSiteLaunchMode(mode);
  const binding = bindingFor(plan), path = resolve(directory, SITE_LAUNCH_RECORD), lock = resolve(directory, 'site.lock');
  const requireLock = () => assert.equal(privateRead(lock, false, stat => {
    if (lockIdentity) assert.ok(stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino, 'The website launch lock was replaced.');
    else lockIdentity = { dev: stat.dev, ino: stat.ino };
  }), String(process.pid), 'The website launch lock is not owned.');
  requireLock();
  let record = openingRecord(plan, directory), active = false, activityConflict = false;
  if (mode === 'prelaunch' && (record || knownMintActivity)) throw refusal();
  return Object.freeze({
    mode,
    activate() {
      requireLock();
      if (mode === 'open' && !record) {
        const openedAt = now(); assert.ok(Number.isSafeInteger(openedAt) && openedAt > 0);
        const next = { version, binding, openedAt };
        let fd, created = false;
        try {
          fd = openSync(path, 'wx', 0o600); created = true;
          writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd);
          const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
          record = next;
        } catch (error) { if (created) unlinkSync(path); throw error; }
        finally { if (fd !== undefined) closeSync(fd); }
      }
      active = true;
    },
    // A later verified chain read may reveal activity missing from the local
    // projection. It closes this presentation gate, never forges sale state.
    observeMintActivity(value) {
      if (mode === 'prelaunch' && hasKnownMintActivity(value)) activityConflict = true;
    },
    state() { return { mode, active, openedAt: record?.openedAt, activityConflict }; },
    assertMintOpen() {
      if (activityConflict) throw refusal();
      if (mode !== 'open' || !active) throw new PublicError(409, 'SITE_NOT_OPEN', 'Minting has not opened yet. Explore previews for now.');
    },
  });
}
