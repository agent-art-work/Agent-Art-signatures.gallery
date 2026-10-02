import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { openMintHandleKey } from '../../src/openMint/authorization.ts';
import { generativeInputDigest } from '../../src/openMint/generativeInputs.ts';
import { INPUT_PROFILE } from './pulse-sepolia-plan.mjs';
import { disposablePostgres } from '../../src/openMint/persistence/fixtures/postgres.ts';
import { openSepoliaRelayStore } from '../../scripts/pulse-sepolia-relay-store.mjs';
import { startSepoliaTestSite } from '../../scripts/pulse-sepolia-site.mjs';
import { createSepoliaGalleryCache } from '../../scripts/pulse-sepolia-cache.mjs';

const H = c => '0x' + c.repeat(64);
const plan = { digest: 'a'.repeat(64), collection: { address: '0x0000000000000000000000000000000000000001' },
  renderer: { identity: H('b'), runtimeCodeHash: H('c') } };
const mint = (block, state) => ({ handle: 'alice', renderHandle: 'Alice', mbti: 'INTJ',
  tokenId: String(BigInt(openMintHandleKey('alice'))), transactionHash: H('d'), block: '0x' + block.toString(16),
  blockHash: H('e'), inputDigest: generativeInputDigest('Alice', 'INTJ', plan.renderer.identity, INPUT_PROFILE), assessmentDigest: H('1'),
  wallet: '0x0000000000000000000000000000000000000002', state });
const snapshot = (at, final = 9, row = mint(10, final >= 10 ? 'minted' : 'confirming')) => ({ at,
  head: { number: '0xa', hash: H('e'), timestamp: '0x5f5e100' },
  finalized: { number: '0x' + final.toString(16), hash: final >= 10 ? H('e') : H('9'), timestamp: '0x5f5e0f0' },
  expectedMintCount: 1, readSource: 'secondary', mints: new Map([['alice', row]]) });

test('the PostgreSQL relay atomically stores only verified public presentation and protects finality',
  { skip: process.env.OPEN_MINT_TEST_POSTGRES !== '1' }, async () => {
    const cluster = disposablePostgres(), pool = new Pool(cluster.config);
    try {
      await pool.query(readFileSync(new URL('../../scripts/pulse-sepolia-relay-schema.sql', import.meta.url), 'utf8'));
      const store = await openSepoliaRelayStore(pool, plan), at = Date.now();
      const key = H('d') + ':' + H('e'), svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      assert.equal(await store.read(), undefined);
      assert.equal(await store.publish(snapshot(at), new Map([[key, svg]])), '1');
      assert.equal((await store.read()).mints.get('alice').state, 'confirming');
      assert.equal(await store.artwork(key), svg);
      assert.equal(await store.publish(snapshot(at + 10, 10)), '2');
      assert.equal((await store.read()).mints.get('alice').state, 'minted');
      await store.publishOwnership({ at: at + 10, head: snapshot(at + 10, 10).head,
        finalized: snapshot(at + 10, 10).finalized,
        owners: new Map([[String(BigInt(openMintHandleKey('alice'))), '0x0000000000000000000000000000000000000002']]),
        finalizedOwners: new Map([[String(BigInt(openMintHandleKey('alice'))), '0x0000000000000000000000000000000000000002']]),
        readSource: 'secondary' });
      assert.equal((await store.readOwnership()).owners.size, 1);
      await store.publishArtwork(key, svg);
      await assert.rejects(store.publishArtwork(key, '<svg id="different"></svg>'), { code: 'MINT_EVIDENCE_CONFLICT' });
      const directory = mkdtempSync(join(tmpdir(), 'sg-relay-site-'));
      try {
        const unavailable = () => Promise.reject(Object.assign(Error('no RPC'), { code: 'RPC_DATA_UNAVAILABLE', retryableRead: true }));
        const site = await startSepoliaTestSite(32007, { plan, journal: {}, directory, relayStore: store,
          cache: createSepoliaGalleryCache(plan, directory), ui: false, intervalMs: 100,
          saveRecords: () => writeFileSync(join(directory, 'web-records.json'), JSON.stringify({ planDigest: plan.digest, requests: {} }), { mode: 0o600 }),
          context: { rpc: unavailable, second: (...args) => unavailable(...args) }, validateSource: async () => {},
          verifyDeployment: unavailable });
        try {
          const home = await fetch('http://127.0.0.1:32007/');
          assert.match(await home.text(), /@Alice/);
          assert.equal(await (await fetch('http://127.0.0.1:32007/test-art/alice.svg')).text(), svg);
          const health = await (await fetch('http://127.0.0.1:32007/health')).json();
          assert.equal(health.relayStore.enabled, true);
          assert.equal(health.mintReady, false);
        } finally { await site.close(); }
      } finally { rmSync(directory, { recursive: true, force: true }); }
      await assert.rejects(store.publish({ ...snapshot(at + 20, 10), mints: new Map(), expectedMintCount: 0 }),
        { code: 'MINT_EVIDENCE_CONFLICT' });
      await assert.rejects(store.publish({ ...snapshot(at + 20, 10), finalized: { number: '0xa', hash: H('8') } }),
        { code: 'MINT_EVIDENCE_CONFLICT' });
      assert.equal((await store.read()).mints.get('alice').state, 'minted');
      await assert.rejects(openSepoliaRelayStore(pool, { ...plan, collection: { address: '0x0000000000000000000000000000000000000003' } }),
        /binding changed/);
    } finally { await pool.end(); cluster.stop(); }
  });
