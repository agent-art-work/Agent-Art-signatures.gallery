import { readFileSync } from "node:fs";
import { deploymentPlan, verifyRelease } from "../contracts/tools/generative-release.mjs";

// Read-only. No lock-generation, environment configuration or deployment mode.
const args = process.argv.slice(2);
if (args.length === 0) console.log(JSON.stringify(verifyRelease(), null, 2));
else if (args.length === 2 && args[0] === "--plan") {
  console.log(JSON.stringify(deploymentPlan(JSON.parse(readFileSync(args[1], "utf8"))), null, 2));
} else throw new Error("Usage: node scripts/verify-generative-release.mjs [--plan explicit-config.json]");
