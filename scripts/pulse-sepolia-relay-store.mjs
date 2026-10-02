import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import { canonicalHandle, preservedHandle, isMbti } from '../src/openMint/identity.ts';
import { openMintHandleKey } from '../src/openMint/authorization.ts';
import { generativeInputDigest } from '../src/openMint/generativeInputs.ts';
import { INPUT_PROFILE } from '../contracts/tools/pulse-sepolia-plan.mjs';

const hex64 = /^0x[0-9a-f]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const conflict = message => Object.assign(new Error(message), { code: 'MINT_EVIDENCE_CONFLICT' });
const stale = () => Object.assign(new Error('Relay observation is older than its stored checkpoint.'),
  { code: 'RPC_DATA_UNAVAILABLE', retryableRead: true });
const publicFields = ['handle','renderHandle','mbti','tokenId','transactionHash','block','blockHash',
  'inputDigest','assessmentDigest','wallet','state'];
const mintPayload = mint => Object.fromEntries(publicFields.map(key => [key, mint[key]]));
const number = value => { assert.match(value, /^0x(?:0|[1-9a-f][0-9a-f]*)$/); return BigInt(value); };
const keyFor = mint => mint.transactionHash + ':' + mint.blockHash;

function validate(snapshot, artworks, pins) {
  assert.ok(snapshot?.mints instanceof Map && snapshot.mints.size <= 100000);
  assert.ok(snapshot.head && snapshot.finalized);
  for (const value of [snapshot.head, snapshot.finalized]) {
    assert.ok(number(value.number) >= 0n); assert.match(value.hash, hex64);
  }
  assert.ok(number(snapshot.finalized.number) <= number(snapshot.head.number));
  if (snapshot.finalized.number === snapshot.head.number && snapshot.finalized.hash !== snapshot.head.hash)
    throw conflict('Finalized and latest identify different blocks at the same height');
  assert.ok(Number.isSafeInteger(snapshot.expectedMintCount) && snapshot.expectedMintCount === snapshot.mints.size);
  assert.ok(snapshot.readSource === 'primary' || snapshot.readSource === 'secondary');
  assert.ok(Number.isSafeInteger(snapshot.at) && snapshot.at > 0);
  assert.ok(artworks instanceof Map);
  for (const [handle, row] of snapshot.mints) {
    assert.equal(canonicalHandle(handle), handle); assert.equal(row.handle, handle);
    assert.equal(preservedHandle(row.renderHandle), row.renderHandle);
    assert.equal(canonicalHandle(row.renderHandle), handle); assert.ok(isMbti(row.mbti));
    assert.equal(row.tokenId, String(BigInt(openMintHandleKey(handle))));
    assert.match(row.transactionHash, hex64); assert.match(row.blockHash, hex64);
    assert.match(row.inputDigest, hex64); assert.match(row.assessmentDigest, hex64);
    assert.equal(row.inputDigest, generativeInputDigest(row.renderHandle, row.mbti, pins.rendererIdentity, INPUT_PROFILE));
    getAddress(row.wallet); assert.ok(number(row.block) <= number(snapshot.head.number));
    if (row.block === snapshot.head.number && row.blockHash !== snapshot.head.hash) throw conflict('Mint/head block mismatch');
    if (row.block === snapshot.finalized.number && row.blockHash !== snapshot.finalized.hash) throw conflict('Mint/finality block mismatch');
    assert.equal(row.state, number(row.block) <= number(snapshot.finalized.number) ? 'minted' : 'confirming');
    if (artworks.has(keyFor(row))) {
      const svg = artworks.get(keyFor(row));
      assert.ok(typeof svg === 'string' && svg.startsWith('<svg') && Buffer.byteLength(svg) <= 16384);
    }
  }
  assert.ok(hex64.test(pins.rendererIdentity) && /^[0-9a-f]{64}$/.test(pins.planDigest));
}

/** Separate, public-only PostgreSQL projection. The caller owns schema migration,
 * connection pool and RPC verification. Publishing a snapshot never establishes
 * mint eligibility. One transaction checks the prior finalized prefix, replaces
 * the provisional tail and advances the checkpoint atomically. */
export async function openSepoliaRelayStore(pool, plan) {
  assert.equal(typeof pool.query, 'function'); assert.equal(typeof pool.connect, 'function');
  const pins = { planDigest: plan.digest, chainId: 11155111, collection: getAddress(plan.collection.address),
    rendererIdentity: plan.renderer.identity, rendererRuntimeCodeHash: plan.renderer.runtimeCodeHash };
  assert.match(pins.planDigest, /^[0-9a-f]{64}$/); assert.match(pins.rendererIdentity, hex64);
  const id = pins.planDigest;
  await pool.query('INSERT INTO pulse_site_relay.deployments(id,pins) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
    [id, JSON.stringify(pins)]);
  const registered = await pool.query('SELECT pins FROM pulse_site_relay.deployments WHERE id=$1', [id]);
  assert.deepEqual(registered.rows[0]?.pins, pins, 'Relay deployment binding changed');

  async function publish(snapshot, artworks = new Map()) {
    validate(snapshot, artworks, pins);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // The deployment row serializes first publication too, when no checkpoint
      // exists yet. A stale concurrent observer cannot overwrite a newer one.
      await db.query('SELECT id FROM pulse_site_relay.deployments WHERE id=$1 FOR UPDATE', [id]);
      const old = (await db.query('SELECT * FROM pulse_site_relay.checkpoints WHERE deployment_id=$1 FOR UPDATE', [id])).rows[0];
      const finalNumber = number(snapshot.finalized.number), headNumber = number(snapshot.head.number);
      if (old) {
        const oldFinal = BigInt(old.finalized_number), oldHead = BigInt(old.head_number);
        if (finalNumber < oldFinal || headNumber < oldFinal || headNumber < oldHead && snapshot.head.hash === old.head_hash) throw stale();
        if (finalNumber === oldFinal && snapshot.finalized.hash !== old.finalized_hash) throw conflict('Finalized relay anchor changed');
        const promoted = (await db.query("SELECT payload FROM pulse_site_relay.works WHERE deployment_id=$1 AND state='minted'", [id])).rows;
        for (const { payload } of promoted) {
          const next = snapshot.mints.get(payload.handle);
          if (!next || next.state !== 'minted') throw conflict('Previously finalized work disappeared');
          if (!isDeepStrictEqual(mintPayload(next), payload)) throw conflict('Previously finalized work changed');
        }
      }
      await db.query("DELETE FROM pulse_site_relay.works WHERE deployment_id=$1 AND state='confirming'", [id]);
      for (const mint of snapshot.mints.values()) {
        const payload = mintPayload(mint);
        await db.query(`INSERT INTO pulse_site_relay.works(deployment_id,handle,token_id,block_number,block_hash,state,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (deployment_id,handle) DO NOTHING`,
        [id, mint.handle, mint.tokenId, number(mint.block).toString(), mint.blockHash, mint.state, JSON.stringify(payload)]);
        const stored = (await db.query('SELECT payload FROM pulse_site_relay.works WHERE deployment_id=$1 AND handle=$2', [id, mint.handle])).rows[0];
        if (!stored) throw conflict('Relay work was not stored');
        if (!isDeepStrictEqual(stored.payload, payload)) throw conflict('Relay work conflicts with existing record');
      }
      for (const mint of snapshot.mints.values()) {
        const key = keyFor(mint), svg = artworks.get(key);
        if (svg === undefined) continue;
        const digest = sha256(svg);
        await db.query('INSERT INTO pulse_site_relay.artworks(deployment_id,key,svg,sha256) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [id, key, svg, digest]);
        const stored = (await db.query('SELECT sha256 FROM pulse_site_relay.artworks WHERE deployment_id=$1 AND key=$2', [id, key])).rows[0];
        if (stored?.sha256 !== digest) throw conflict('Relay artwork bytes changed');
      }
      const revision = old ? BigInt(old.revision) + 1n : 1n;
      await db.query(`INSERT INTO pulse_site_relay.checkpoints(deployment_id,revision,head_number,head_hash,head_timestamp,
        finalized_number,finalized_hash,verified_at,expected_mint_count,observed_mint_count,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000),$9,$10,$11)
        ON CONFLICT (deployment_id) DO UPDATE SET revision=EXCLUDED.revision,head_number=EXCLUDED.head_number,
        head_hash=EXCLUDED.head_hash,head_timestamp=EXCLUDED.head_timestamp,finalized_number=EXCLUDED.finalized_number,
        finalized_hash=EXCLUDED.finalized_hash,verified_at=EXCLUDED.verified_at,
        expected_mint_count=EXCLUDED.expected_mint_count,observed_mint_count=EXCLUDED.observed_mint_count,source=EXCLUDED.source`,
      [id, revision.toString(), headNumber.toString(), snapshot.head.hash, number(snapshot.head.timestamp).toString(),
        finalNumber.toString(), snapshot.finalized.hash, snapshot.at, snapshot.expectedMintCount, snapshot.mints.size, snapshot.readSource]);
      await db.query(`INSERT INTO pulse_site_relay.observations(deployment_id,revision,head_number,head_hash,
        finalized_number,finalized_hash,source,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000))`,
      [id, revision.toString(), headNumber.toString(), snapshot.head.hash, finalNumber.toString(), snapshot.finalized.hash,
        snapshot.readSource, snapshot.at]);
      await db.query('COMMIT');
      return revision.toString();
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async function read() {
    const db = await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = (await db.query('SELECT * FROM pulse_site_relay.checkpoints WHERE deployment_id=$1', [id])).rows[0];
      if (!state) { await db.query('COMMIT'); return undefined; }
      const rows = (await db.query('SELECT payload FROM pulse_site_relay.works WHERE deployment_id=$1 ORDER BY block_number,handle', [id])).rows;
      if (rows.length !== state.observed_mint_count) throw conflict('Relay checkpoint and works disagree');
      const value = { at: new Date(state.verified_at).getTime(),
        head: { number: '0x' + BigInt(state.head_number).toString(16), hash: state.head_hash,
          timestamp: '0x' + BigInt(state.head_timestamp).toString(16) },
        finalized: { number: '0x' + BigInt(state.finalized_number).toString(16), hash: state.finalized_hash },
        expectedMintCount: state.expected_mint_count, readSource: state.source,
        mints: new Map(rows.map(({ payload }) => [payload.handle, payload])) };
      validate(value, new Map(), pins);
      await db.query('COMMIT');
      return value;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async function artwork(key) {
    assert.match(key, /^0x[0-9a-f]{64}:0x[0-9a-f]{64}$/);
    const row = (await pool.query('SELECT svg,sha256 FROM pulse_site_relay.artworks WHERE deployment_id=$1 AND key=$2', [id, key])).rows[0];
    if (!row) return undefined;
    assert.equal(sha256(row.svg), row.sha256, 'Relay artwork checksum mismatch');
    return row.svg;
  }
  async function publishArtwork(key, svg) {
    assert.match(key, /^0x[0-9a-f]{64}:0x[0-9a-f]{64}$/);
    assert.ok(typeof svg === 'string' && svg.startsWith('<svg') && Buffer.byteLength(svg) <= 16384);
    const known = await pool.query(`SELECT 1 FROM pulse_site_relay.works WHERE deployment_id=$1
      AND (payload->>'transactionHash') || ':' || (payload->>'blockHash') = $2`, [id, key]);
    if (!known.rowCount) throw stale();
    const digest = sha256(svg);
    await pool.query('INSERT INTO pulse_site_relay.artworks(deployment_id,key,svg,sha256) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [id, key, svg, digest]);
    const stored = await pool.query('SELECT sha256 FROM pulse_site_relay.artworks WHERE deployment_id=$1 AND key=$2', [id, key]);
    if (stored.rows[0]?.sha256 !== digest) throw conflict('Relay artwork bytes changed');
  }
  async function publishOwnership(value) {
    assert.ok(value?.owners instanceof Map && value.finalizedOwners instanceof Map);
    assert.ok(value.readSource === 'primary' || value.readSource === 'secondary');
    assert.ok(number(value.finalized.number) <= number(value.head.number));
    for (const [token, wallet] of [...value.owners, ...value.finalizedOwners]) {
      assert.match(token, /^(0|[1-9][0-9]*)$/); assert.equal(getAddress(wallet), wallet);
    }
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT id FROM pulse_site_relay.deployments WHERE id=$1 FOR UPDATE', [id]);
      const checkpoint = (await db.query('SELECT head_number,head_hash FROM pulse_site_relay.checkpoints WHERE deployment_id=$1', [id])).rows[0];
      if (!checkpoint || number(value.head.number) > BigInt(checkpoint.head_number)) throw stale();
      if (number(value.head.number) === BigInt(checkpoint.head_number) && value.head.hash !== checkpoint.head_hash)
        throw conflict('Ownership and mint checkpoints disagree');
      const old = (await db.query('SELECT * FROM pulse_site_relay.ownership WHERE deployment_id=$1 FOR UPDATE', [id])).rows[0];
      if (old) {
        if (number(value.head.number) < BigInt(old.head_number) || number(value.finalized.number) < BigInt(old.finalized_number)) throw stale();
        if (number(value.finalized.number) === BigInt(old.finalized_number) &&
          (value.finalized.hash !== old.finalized_hash || !isDeepStrictEqual(Object.fromEntries(value.finalizedOwners), old.finalized_owners)))
          throw conflict('Finalized ownership changed');
      }
      await db.query(`INSERT INTO pulse_site_relay.ownership(deployment_id,head_number,head_hash,finalized_number,
        finalized_hash,owners,finalized_owners,verified_at,source)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,to_timestamp($8::double precision/1000),$9)
        ON CONFLICT (deployment_id) DO UPDATE SET head_number=EXCLUDED.head_number,head_hash=EXCLUDED.head_hash,
        finalized_number=EXCLUDED.finalized_number,finalized_hash=EXCLUDED.finalized_hash,
        owners=EXCLUDED.owners,finalized_owners=EXCLUDED.finalized_owners,verified_at=EXCLUDED.verified_at,source=EXCLUDED.source`,
      [id, number(value.head.number).toString(), value.head.hash, number(value.finalized.number).toString(),
        value.finalized.hash, JSON.stringify(Object.fromEntries(value.owners)), JSON.stringify(Object.fromEntries(value.finalizedOwners)),
        value.at, value.readSource]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async function readOwnership() {
    const row = (await pool.query('SELECT * FROM pulse_site_relay.ownership WHERE deployment_id=$1', [id])).rows[0];
    if (!row) return undefined;
    const owners = new Map(Object.entries(row.owners)), finalizedOwners = new Map(Object.entries(row.finalized_owners));
    for (const [token, wallet] of [...owners, ...finalizedOwners]) {
      assert.match(token, /^(0|[1-9][0-9]*)$/); assert.equal(getAddress(wallet), wallet);
    }
    assert.ok(BigInt(row.finalized_number) <= BigInt(row.head_number));
    return { at: new Date(row.verified_at).getTime(),
      head: { number: '0x' + BigInt(row.head_number).toString(16), hash: row.head_hash },
      finalized: { number: '0x' + BigInt(row.finalized_number).toString(16), hash: row.finalized_hash },
      owners, finalizedOwners,
      readSource: row.source };
  }
  return Object.freeze({ pins, publish, read, artwork, publishArtwork, publishOwnership, readOwnership });
}
