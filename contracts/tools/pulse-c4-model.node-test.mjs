import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const vectors = JSON.parse(readFileSync(new URL('../vendor/pulse-core-v1.0.0/vectors.json', import.meta.url)));
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const U256 = (1n << 256n) - 1n;
const fault = (name, ...args) => { throw { name, args: args.map(String) }; };
const convert = value => Object.fromEntries(Object.entries(value).map(([key, n]) => [key, BigInt(n)]));
const initial = (c, start) => {
  if (c.k === 0n) fault('InvalidCurveK');
  if (c.genesisPrice <= c.genesisFloor) fault('InvalidGenesisPrices');
  const gap = c.genesisPrice - c.genesisFloor;
  if (gap > c.k) fault('GenesisGapExceedsK');
  if (c.pts === 0n || c.pts > U128) fault('InvalidPts');
  const transitionDistance = c.k / c.pts;
  if (transitionDistance > U64) fault('TimeScaleOutOfRange');
  const initialDistance = c.k / gap;
  const threshold = initialDistance > transitionDistance ? initialDistance : transitionDistance;
  if (start <= threshold) fault('StartTimeTooEarly', start, threshold);
  const s = { epochIndex: 0n, openTime: start, curveStartTime: start,
    anchorTime: start - initialDistance, floorPrice: c.genesisFloor };
  price(c, s, start);
  return s;
};
const price = (c, s, t) => {
  const delta = t > s.anchorTime ? t - s.anchorTime : 0n;
  const addition = delta === 0n ? c.k : c.k / delta;
  if (addition > U256 - s.floorPrice) fault('PriceOverflow');
  return s.floorPrice + addition;
};
const valid = (c, s) => {
  const genesis = initial(c, s.openTime);
  if (s.curveStartTime < s.openTime || s.anchorTime === 0n || s.anchorTime > s.curveStartTime ||
      s.floorPrice < c.genesisFloor ||
      (s.epochIndex === 0n && (s.curveStartTime !== genesis.curveStartTime ||
        s.anchorTime !== genesis.anchorTime || s.floorPrice !== genesis.floorPrice))) fault('InvalidState');
  price(c, s, s.curveStartTime);
};
const quote = (c, s, t) => {
  valid(c, s);
  if (s.epochIndex === 0n && t < s.openTime) t = s.openTime;
  else if (s.epochIndex !== 0n && t < s.curveStartTime) fault('TimestampBeforeEpoch', t, s.curveStartTime);
  return price(c, s, t);
};
const advance = (c, s, t) => {
  valid(c, s);
  if (t < s.curveStartTime) fault('TimestampBeforeEpoch', t, s.curveStartTime);
  if (s.epochIndex === U64) fault('EpochOverflow');
  const ask = price(c, s, t);
  const elapsed = t - s.curveStartTime;
  const premium = (elapsed === 0n ? 1n : elapsed) * c.pts;
  if (premium > U256 - ask) fault('TargetPriceOverflow');
  const nextState = { epochIndex: s.epochIndex + 1n, openTime: s.openTime,
    curveStartTime: t, anchorTime: t - c.k / premium, floorPrice: ask };
  price(c, nextState, t);
  return { ask, nextState };
};
const decimals = value => typeof value === 'bigint' ? value.toString() :
  Array.isArray(value) ? value.map(decimals) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decimals(v)])) : value;

test('independent BigInt model agrees with all 67 pinned Pulse Core release vectors', () => {
  assert.equal(vectors.cases.length, 67);
  for (const item of vectors.cases) {
    const config = convert(typeof item.config === 'string' ? vectors.configs[item.config] : item.config);
    const state = item.state === undefined ? undefined : convert(typeof item.state === 'string' ? vectors.states[item.state] : item.state);
    const time = BigInt(item.startTime ?? item.timestamp);
    let observed;
    try {
      observed = item.method === 'initialize' ? initial(config, time) :
        item.method === 'quote' ? quote(config, state, time) : advance(config, state, time);
      assert.equal(item.error, undefined, `${item.id}: expected ${item.error?.name}`);
      assert.deepEqual(decimals(observed), item.expected, item.id);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.deepEqual(error, item.error, item.id);
    }
  }
});
