import { admissionDigest } from "../staging/admission.js";

/** Ordered SOURCE identity, not proof of execution on any database. Explicit
 * operator migrations only. No runtime discovers, installs or updates this lock. */
export const GENERATIVE_DATABASE_MIGRATIONS = Object.freeze([
  ["schema.sql", "e454c92d17640923124dd0fa845033420f7052d845471923029873587f693445"],
  ["requests-schema.sql", "630e0a8c24139b81a030d68bb02d0982a611d0895456f00684982d142e4c4b94"],
  ["generative-input-schema.sql", "7767f221433188b413582e685298c79e59402c4bf7e1fd53a6f41964c949fa94"],
  ["generative-release-profile-schema.sql", "807deb3d02418a8a5213d6ec0d511196f5ec459e51d9ef1a821291e7afaa34ef"],
  ["generative-authorization-schema.sql", "41d569ab236a02c265b3efc4a410af691c65d7f692ed2cab16a69c8add5ea75f"],
  ["wallet-submission-schema.sql", "4d10c5901471a01ecfab7404428ca729e08ae8238896bf8d7d93d2c70d448ec0"],
  ["../projection/projection-schema.sql", "8d7f64fd9802b5243e5318f6b740bdce767be351f63cf44c7d9d8c93252ab779"],
  ["../projection/projection-v2.sql", "cefbb1ebbd60045342af06c4b8d30c8d68427842b58da9bd374c532d1591bbba"],
  ["../projection/projection-v3.sql", "30eba14c6bb6ab8b96023aaf77ea6186ac2c3de25826d1e50f67eb528e058351"],
].map(([path, sha256]) => Object.freeze({ path, sha256 })));

/** Reproducible PostgreSQL 16 catalog, after the ordered migrations and exact
 * browser grants, on an empty disposable cluster. Not independent approval.
 * No OIDs, physical sizes, statistics, object comments or live mint rows. */
export const GENERATIVE_DATABASE_LOCK = Object.freeze({
  version: "sg-generative-database-v1",
  migrationManifestSha256: admissionDigest(GENERATIVE_DATABASE_MIGRATIONS),
  schemaSha256: "598d24e9ac3f850ab4e016b4eb49255c679886d90d9346bcde602126c5743d54",
  grantsSha256: "ada7eba9dc02b86a38a437af0973c5aec7b7a928942aaa6ce05fc7eea1257037",
});
