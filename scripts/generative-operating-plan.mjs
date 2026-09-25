import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { operatingPlan } from "../contracts/tools/generative-operating-plan.mjs";
import { OPERATING_PLAN_MAX_BYTES, OperatingPlanError } from "../src/openMint/staging/operatingPlan.ts";

// Explicit file only, no .env load, stdin/pipe, symlink, network, secret lookup,
// output file write, provisioning, signature or broadcast operation.
try {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") throw new OperatingPlanError("arguments (expected --input FILE)");
  const fd = openSync(process.argv[3], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let json;
  try {
    if (!fstatSync(fd).isFile()) throw new OperatingPlanError("regular input file");
    const buffer = Buffer.alloc(OPERATING_PLAN_MAX_BYTES + 1);
    let total = 0, count;
    while (total < buffer.length && (count = readSync(fd, buffer, total, buffer.length - total, null)) > 0) total += count;
    if (total > OPERATING_PLAN_MAX_BYTES) throw new OperatingPlanError("input size");
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total));
  } finally { closeSync(fd); }
  process.stdout.write(JSON.stringify(operatingPlan(json), null, 2) + "\n");
} catch (error) {
  process.stderr.write((error instanceof OperatingPlanError ? error.message : "Operating plan rejected: input or release unavailable.") + "\n");
  process.exitCode = 1;
}
