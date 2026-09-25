import { admissionDigest } from "../staging/admission.js";
import { GENERATIVE_DATABASE_MIGRATIONS } from "./databaseSchemaLock.js";

/** Explicit v2 extension. The v1 exported manifest and every v1 source hash
 * stay byte-for-byte unchanged; no startup path discovers this version. */
export const GENERATIVE_DATABASE_V2_MIGRATIONS = Object.freeze([
  ...GENERATIVE_DATABASE_MIGRATIONS,
  Object.freeze({ path: "generative-staging-recovery-schema.sql", sha256: "717c9a317408739926c2d62096d02697e1632a3ee71b4aaa51b68b7684fb313b" }),
]);
export const GENERATIVE_DATABASE_V2_LOCK = Object.freeze({
  version: "sg-generative-database-v2",
  migrationManifestSha256: admissionDigest(GENERATIVE_DATABASE_V2_MIGRATIONS),
  schemaSha256: "dfe31d5d01a1ee56bcdb4678c62b71ed74c4cfe89732a95280d75c0582a42e0e",
  grantsSha256: "3681279ffb2774661e41f57c961ebf78f9463045570086ea6bb154bc06d7f38e",
});
