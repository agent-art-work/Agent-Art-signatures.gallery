import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSepoliaRelayScheduler } from '../../scripts/pulse-sepolia-relay.mjs';

const head = (number, marker = 'a') => ({ number: '0x' + number.toString(16), hash: '0x' + marker.repeat(64) });
const point = (number, finalized = number) => ({ head: head(number), finalized: head(finalized, 'b') });
const transient = () => Object.assign(Error('timeout'), { retryableRead: true });

test('a burst of visitors causes one head probe and no full sync when the verified head is unchanged', async () => {
  let time = 1000, probes = 0, scans = 0;
  const relay = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5000,
    probe: async () => { probes++; return point(10, 9); },
    synchronize: async value => { scans++; return value; } });
  relay.seed(point(10, 9));
  assert.deepEqual(await Promise.all(Array.from({ length: 40 }, () => relay.wake())), Array(40).fill('unchanged'));
  assert.equal(probes, 1); assert.equal(scans, 0);
  time += 4999; assert.equal(await relay.wake(), 'leased'); assert.equal(probes, 1);
  time++; assert.equal(await relay.wake(), 'unchanged'); assert.equal(probes, 2); assert.equal(scans, 0);
});

test('a changed finalized head or latest head causes one complete sync and accepts its verified checkpoint', async () => {
  let time = 1000, next = point(11, 9), scans = 0;
  const relay = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5,
    probe: async () => next, synchronize: async () => { scans++; return point(12, 10); } });
  relay.seed(point(10, 9));
  assert.equal(await relay.wake(), 'updated'); assert.equal(scans, 1);
  assert.deepEqual(relay.state().head, point(12, 10).head);
  time += 5; next = point(12, 11);
  assert.equal(await relay.wake(), 'updated'); assert.equal(scans, 2);
});

test('one in-flight sync coalesces requests, failure backs off, and conflict halts', async () => {
  let time = 1000, release, probes = 0;
  const relay = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5,
    probe: async () => { probes++; return point(12, 10); },
    synchronize: () => new Promise(resolve => { release = resolve; }) });
  relay.seed(point(10, 9));
  const first = relay.wake(); await new Promise(resolve => setImmediate(resolve));
  const second = relay.wake(); assert.equal(probes, 1);
  release(point(12, 10)); assert.deepEqual(await Promise.all([first, second]), ['updated', 'updated']);
  const broken = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5,
    probe: async () => { throw transient(); }, synchronize: async value => value });
  assert.equal(await broken.wake(), 'unavailable'); assert.equal(await broken.wake(), 'cooldown');
  time += 10; assert.equal(await broken.wake(), 'unavailable');
  const conflict = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5,
    probe: async () => { throw Object.assign(Error('finalized conflict'), { code: 'MINT_EVIDENCE_CONFLICT' }); },
    synchronize: async value => value });
  assert.equal(await conflict.wake(), 'safety-halted'); assert.equal(conflict.state().phase, 'safety-halted');
});

test('a slow successful sync receives a completion lease instead of immediately scanning again', async () => {
  let time = 1000, probes = 0;
  const relay = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5000,
    probe: async () => { probes++; return point(12, 10); },
    synchronize: async value => { time += 20000; return value; } });
  relay.seed(point(10, 9)); await relay.wake();
  assert.equal(await relay.wake(), 'cooldown'); assert.equal(probes, 1);
  time += 5000; assert.equal(await relay.wake(), 'unchanged'); assert.equal(probes, 2);
});

test('new verified observation supersedes an old transport failure, never a safety halt', async () => {
  let time = 1000;
  const relay = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5,
    probe: async () => { throw transient(); }, synchronize: async value => value });
  await relay.wake(); assert.equal(relay.state().lastError, 'RPC_DATA_UNAVAILABLE');
  assert.equal(relay.state().firstFailedAt, time);
  time++; relay.seed({ ...point(12, 10), at: time }); assert.equal(relay.state().lastError, undefined);
  assert.equal(relay.state().firstFailedAt, undefined);
  const halted = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5,
    probe: async () => { throw Object.assign(Error('conflict'), { code: 'MINT_EVIDENCE_CONFLICT' }); },
    synchronize: async value => value });
  await halted.wake(); time++; halted.seed({ ...point(12, 10), at: time });
  assert.equal(halted.state().lastError, 'MINT_EVIDENCE_CONFLICT'); assert.equal(await halted.wake(), 'safety-halted');
});

test('repeated relay failures keep the original episode clock, and success resets it', async () => {
  let time = 1000, fail = true;
  const relay = createSepoliaRelayScheduler({ now: () => time, leaseMs: 5,
    probe: async () => { if (fail) throw transient(); return point(12, 10); },
    synchronize: async value => value });
  await relay.wake(); assert.equal(relay.state().firstFailedAt, 1000);
  time += 100; await relay.wake();
  assert.equal(relay.state().failedAt, 1100); assert.equal(relay.state().firstFailedAt, 1000);
  relay.seed({ ...point(12, 10), at: 1001 });
  assert.equal(relay.state().firstFailedAt, 1000); // Older evidence is not recovery.
  fail = false; time += 100; await relay.wake();
  assert.equal(relay.state().firstFailedAt, undefined);
  fail = true; time += 100; await relay.wake(); assert.equal(relay.state().firstFailedAt, 1300);
});

test('unknown relay exceptions block demand until explicit review, without inventing an RPC outage or conflict', async () => {
  let calls = 0, fail = true;
  const relay = createSepoliaRelayScheduler({ leaseMs: 5, probe: async () => {
    calls++; if (fail) throw TypeError('secret response https://private.example/KEY'); return point(12, 10);
  }, synchronize: async value => value });
  assert.equal(await relay.wake(), 'blocked'); assert.equal(relay.state().lastError, 'READ_SERVICE_BLOCKED');
  assert.equal(await relay.wake(), 'blocked'); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(relay.state()), /secret|private|KEY|https/);
  fail = false; assert.equal(await relay.wake({ force: true }), 'updated');
});
