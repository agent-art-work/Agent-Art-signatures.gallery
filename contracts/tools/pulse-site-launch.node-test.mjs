import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSiteLaunchGate, hasKnownMintActivity, SITE_LAUNCH_RECORD, releaseOwnedSiteLock, assertSitePrelaunchAllowed } from '../../scripts/pulse-site-launch.mjs';

const plan = { digest: '0x' + 'ab'.repeat(32), contractProfile: 'generative-pulse-v1-rc2', collection: { address: '0x' + '11'.repeat(20) } };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sg-site-launch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lock = join(directory, 'site.lock'), path = join(directory, SITE_LAUNCH_RECORD);
  writeFileSync(lock, String(process.pid), { mode: 0o600 });
  return { directory, lock, path, gate: options => createSiteLaunchGate({ plan, directory, ...options }) };
}
test('default open records one exact deployment opening only after activation; reopening does not rewrite it', t => {
  const f = fixture(t), gate = f.gate({ now: () => 123 });
  assert.equal(gate.mode, 'open'); assert.equal(existsSync(f.path), false);
  assert.throws(() => gate.assertMintOpen(), { code: 'SITE_NOT_OPEN' });
  gate.activate(); gate.assertMintOpen();
  const original = readFileSync(f.path, 'utf8'), record = JSON.parse(original);
  assert.equal(record.openedAt, 123); assert.deepEqual(record.binding, { planDigest: plan.digest,
    contractProfile: plan.contractProfile, chainId: 11155111, collection: plan.collection.address });
  assert.equal(statSync(f.path).mode & 0o077, 0);
  gate.activate(); f.gate({ now: () => 456 }).activate();
  assert.equal(readFileSync(f.path, 'utf8'), original);
  assert.throws(() => f.gate({ mode: 'prelaunch' }), { code: 'SITE_ALREADY_OPEN' });
});
test('explicit prelaunch writes no opening record and refuses mint authority before and after activation', t => {
  const f = fixture(t), gate = f.gate({ mode: 'prelaunch' });
  assert.throws(() => gate.assertMintOpen(), { code: 'SITE_NOT_OPEN' });
  gate.activate(); assert.equal(gate.state().active, true); assert.equal(existsSync(f.path), false);
  assert.throws(() => gate.assertMintOpen(), { code: 'SITE_NOT_OPEN' });
  const next = f.gate(); next.activate(); next.assertMintOpen();
  assert.throws(() => f.gate({ mode: 'prelaunch' }), { code: 'SITE_ALREADY_OPEN' });
});
test('known and subsequently verified activity refuse a never-opened presentation without forging chain phase', t => {
  const f = fixture(t);
  assert.throws(() => f.gate({ mode: 'prelaunch', knownMintActivity: true }), { code: 'SITE_ALREADY_OPEN' });
  const gate = f.gate({ mode: 'prelaunch' }); gate.activate();
  gate.observeMintActivity({ sale: { phase: 1, paused: true, freeMinted: 0, lastPaidMintBlock: 0 } });
  assert.equal(gate.state().activityConflict, false); // Deadline/maintenance is not launch evidence.
  gate.observeMintActivity({ mints: new Map([['alice', {}]]) });
  gate.observeMintActivity({ mints: new Map() });
  assert.equal(gate.state().activityConflict, true);
  assert.throws(() => gate.assertMintOpen(), { code: 'SITE_ALREADY_OPEN' });
  assert.equal(existsSync(f.path), false);
  const open = f.gate(); open.activate(); open.observeMintActivity({ freeMinted: 1 }); open.assertMintOpen();
  assert.equal(hasKnownMintActivity({ freeMinted: '1' }), true);
  assert.equal(hasKnownMintActivity({ sale: { lastPaidMintBlock: '1' } }), true);
  assert.equal(hasKnownMintActivity(undefined), false);
});
for (const [name, changed] of [['plan', { digest: '0x' + 'cd'.repeat(32) }], ['profile', { contractProfile: 'another-profile' }],
  ['collection', { collection: { address: '0x' + '22'.repeat(20) } }]]) {
  test(`an opening record cannot be reused for another ${name}`, t => {
    const f = fixture(t); f.gate().activate();
    const original = readFileSync(f.path, 'utf8');
    assert.throws(() => createSiteLaunchGate({ directory: f.directory, plan: { ...plan, ...changed } }));
    assert.equal(readFileSync(f.path, 'utf8'), original);
  });
}
test('invalid mode, malformed/overlong state and nonprivate state refuse; they are not silently repaired', t => {
  const f = fixture(t);
  assert.throws(() => f.gate({ mode: 'paused' }), /Invalid website launch mode/);
  writeFileSync(f.path, '{', { mode: 0o600 }); assert.throws(() => f.gate());
  writeFileSync(f.path, 'x'.repeat(4097)); assert.throws(() => f.gate(), /Invalid private launch state/);
  unlinkSync(f.path); f.gate().activate(); chmodSync(f.path, 0o644);
  assert.throws(() => f.gate(), /Invalid private launch state/);
});
test('a symbolic-link launch record or lock is never followed', t => {
  const f = fixture(t), target = join(f.directory, 'target');
  writeFileSync(target, 'private untouched fixture', { mode: 0o600 });
  symlinkSync(target, f.path); assert.throws(() => f.gate());
  unlinkSync(f.path); unlinkSync(f.lock); symlinkSync(target, f.lock);
  assert.throws(() => f.gate()); assert.equal(readFileSync(target, 'utf8'), 'private untouched fixture');
});
test('missing/wrong process lock prevents both construction and deferred activation', t => {
  const f = fixture(t), gate = f.gate();
  writeFileSync(f.lock, 'another owner'); assert.throws(() => f.gate(), /not owned/);
  assert.throws(() => gate.activate(), /not owned/); assert.equal(existsSync(f.path), false);
  unlinkSync(f.lock); assert.throws(() => f.gate(), { code: 'ENOENT' });
});
test('deferred exclusive create never overwrites a competing record or marks a failed activation open', t => {
  const f = fixture(t), gate = f.gate();
  writeFileSync(f.path, 'untouched competing record', { mode: 0o600 });
  assert.throws(() => gate.activate(), { code: 'EEXIST' });
  assert.equal(gate.state().active, false); assert.equal(readFileSync(f.path, 'utf8'), 'untouched competing record');
  assert.throws(() => gate.assertMintOpen(), { code: 'SITE_NOT_OPEN' });
});
test('read-only deployment-bound previews validate opening history without taking a lock or creating records', t => {
  const f = fixture(t); unlinkSync(f.lock);
  assertSitePrelaunchAllowed({ plan, directory: f.directory });
  assert.equal(existsSync(f.path), false); assert.equal(existsSync(f.lock), false);
  assert.throws(() => assertSitePrelaunchAllowed({ plan, directory: f.directory, knownMintActivity: true }), { code: 'SITE_ALREADY_OPEN' });
  writeFileSync(f.lock, String(process.pid), { mode: 0o600 }); f.gate().activate();
  assert.throws(() => assertSitePrelaunchAllowed({ plan, directory: f.directory }), { code: 'SITE_ALREADY_OPEN' });
});
test('lock replacement cannot authorize activation or be deleted by an earlier owner, even with the same PID', t => {
  const f = fixture(t), identity = statSync(f.lock), gate = f.gate();
  renameSync(f.lock, join(f.directory, 'original-lock'));
  writeFileSync(f.lock, String(process.pid), { mode: 0o600 });
  assert.throws(() => gate.activate(), /lock was replaced/);
  assert.equal(releaseOwnedSiteLock(f.lock, identity), false); assert.equal(existsSync(f.lock), true);
  const current = statSync(f.lock); writeFileSync(f.lock, 'another PID');
  assert.equal(releaseOwnedSiteLock(f.lock, current), false); assert.equal(existsSync(f.lock), true);
  writeFileSync(f.lock, String(process.pid)); assert.equal(releaseOwnedSiteLock(f.lock, current), true);
  assert.equal(releaseOwnedSiteLock(f.lock, current), false);
});
