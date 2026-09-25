import { numericalWorksheet } from "../contracts/tools/generative-numerics.mjs";

// Read-only: no credentials, RPC, deployment, report import or lock rewrite.
if (process.argv.length !== 2) throw new Error("This read-only worksheet takes no arguments");
console.log(JSON.stringify(numericalWorksheet(), null, 2));
