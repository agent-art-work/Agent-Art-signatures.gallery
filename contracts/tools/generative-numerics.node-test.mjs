import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { numericalWorksheet, topology } from "./generative-numerics.mjs";
import { ROOT } from "./generative-release.mjs";
import { GENERATIVE_READ_LIMITS } from "../../src/openMint/generativeReadLimits.ts";

for (const [length, mask, expected] of [
  [1, 0, { points: 2, digits: 0, runs: 0 }],
  [1, 1, { points: 3, digits: 1, runs: 1 }],
  [15, 0, { points: 15, digits: 0, runs: 0 }],
  [15, 32767, { points: 31, digits: 15, runs: 1 }],
  [15, 21845, { points: 31, digits: 8, runs: 8 }],
  [15, 10922, { points: 29, digits: 7, runs: 7 }],
]) test(`digit topology length=${length} mask=${mask}`, () => assert.deepEqual(topology(length, mask), expected));

for (const [length, mask] of [[0, 0], [16, 0], [1.5, 0], [NaN, 0], [1, -1], [1, 2], [2, 0.5], [2, NaN]]) {
  test(`invalid topology ${length}/${mask}`, () => assert.throws(() => topology(length, mask)));
}
test("locked worksheet: all topologies, structural counts and conservative size ceilings", () => {
  const report = numericalWorksheet();
  assert.equal(report.releaseLockSha256, "508eefdca3073b8ba97d8a56bc407b9c5c3a6cd8e85a009ad483949d47c386b4");
  assert.deepEqual(report.structure, { topologyCases: 65534, maxPoints: 31, centerOutlineEvaluations: 1950,
    sampledHalf: 252, sampledMaxAtPoints: [29], sampledVertices: 506, bezierCurves: 60, bezierOffsetEvaluations: 242 });
  assert.deepEqual(report.output, { sampledPathBytes: 9109, bezierPathBytes: 3641, svgStaticBytes: 361,
    svgBytes: 9506, metadataStaticBytes: 360, metadataJsonBytes: 13259, tokenUriBytes: 17709, artworkAbiBytes: 17792 });
  assert.ok(report.output.svgBytes < GENERATIVE_READ_LIMITS.svgBytes);
  assert.ok(report.output.metadataJsonBytes < GENERATIVE_READ_LIMITS.metadataJsonBytes);
  assert.ok(report.output.artworkAbiBytes < GENERATIVE_READ_LIMITS.artworkAbiBytes);
  assert.ok(BigInt(report.arithmetic.absoluteSineBound) > 11n * 10n ** 18n);
  assert.ok(BigInt(report.arithmetic.productOrSquareSumBound) < BigInt(report.arithmetic.int256Max));
  for (const field of ["formalProgramProof", "universalGasBound", "universalOracleParity", "independentSecurityApproval", "runtimeAdmissionAllowed"]) {
    assert.equal(report[field], false, field);
  }
  assert.deepEqual(report, numericalWorksheet(), "deterministic, read-only report");
});
test("worksheet refuses changed oracle source instead of treating a report as approval", () => {
  const directory = mkdtempSync(join(tmpdir(), "sg-numerics-lock-"));
  try {
    mkdirSync(join(directory, "reference/algorithm-v2.0.0"), { recursive: true });
    writeFileSync(join(directory, "reference/algorithm-v2.0.0/renderer-lock.json"),
      readFileSync(join(ROOT, "reference/algorithm-v2.0.0/renderer-lock.json")));
    writeFileSync(join(directory, "reference/algorithm-v2.0.0/signature_renderer_v2.0.0.py"), "changed");
    assert.throws(() => numericalWorksheet(directory), /oracle source/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
