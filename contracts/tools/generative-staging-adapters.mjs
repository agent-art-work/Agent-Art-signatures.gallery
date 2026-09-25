import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicChainHttpRpc } from "../../src/openMint/publicChainRpc.ts";
import { XApiIdentityResolver } from "../../src/openMint/xIdentity.ts";
import { GrokAssessmentProvider } from "../../src/openMint/grok.ts";
import { GROK_PILOT_PROFILE } from "../../src/openMint/providerProfile.ts";
import { readFileBounded } from "./generative-staging-bootstrap.mjs";
import { readMountedSecret } from "./generative-staging-mounts.mjs";

const deny = () => { throw Error("Staging adapter unavailable."); };
const sha = text => createHash("sha256").update(text).digest("hex");

/** Explicit authenticated browser-role primary; no libpq environment fallback,
 * pool, replica, reconnect or connection string parsing. TLS identity is the
 * configured host plus independently pinned CA, not a resource label alone. */
function roleConnectionFactory(installation, roleKind, clientConstructor = Client) {
  try {
    const { config, operating, evidence } = installation, d = config.connections.database, s = operating.operatingPlan.settings;
    assert.ok(roleKind === "browser" || roleKind === "inspector");
    assert.equal(d.browserRole, s.database.roles.browser.name);
    const role = s.database.roles[roleKind];
    assert.ok(role && typeof role.name === "string" && typeof role.connectionSecretReference === "string");
    if (roleKind === "inspector") assert.equal(role.name, evidence.databaseReview.inspectorRole);
    const secret = readMountedSecret(config, role.connectionSecretReference);
    const ca = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileBounded(d.tlsRoot.path, d.tlsRoot.maxBytes, d.tlsRoot.sha256));
    assert.ok(/^-----BEGIN CERTIFICATE-----\n/.test(ca) && ca.includes("\n-----END CERTIFICATE-----"));
    assert.ok(typeof secret === "string" && secret.length <= 4096);
    return () => {
      const client = new clientConstructor({ host: d.host, port: d.port, database: d.database, user: role.name, password: secret,
        ssl: { ca, rejectUnauthorized: true, servername: d.host }, connectionTimeoutMillis: s.hosting.requestTimeoutMs,
        application_name: "signatures-gallery-staging", options: "-c search_path=pg_catalog -c timezone=UTC" });
      return Object.freeze({
        on: client.on.bind(client), query: client.query.bind(client), end: client.end.bind(client),
        async connect() {
          await client.connect();
          const q = await client.query("SELECT session_user, current_user, current_database() AS database, current_setting('server_version_num') AS version, pg_is_in_recovery() AS replica");
          const row = q.rows[0];
          assert.ok(q.rows.length === 1 && row?.session_user === role.name && row.current_user === role.name
            && row.database === evidence.databaseReview.database && /^16[0-9]{4}$/.test(row.version) && row.replica === false);
        },
      });
    };
  } catch { return deny(); }
}

export const browserConnectionFactory = (installation, clientConstructor = Client) => roleConnectionFactory(installation, "browser", clientConstructor);
export const inspectorConnectionFactory = (installation, clientConstructor = Client) => roleConnectionFactory(installation, "inspector", clientConstructor);

/** Two configured HTTPS read-only sources. These identities still require R9's
 * externally reviewed operator/account evidence; URLs alone do not prove it. */
export function createMountedRpcs(installation, fetchFn = fetch) {
  try {
    const { config, operating } = installation, s = operating.operatingPlan.settings;
    const urls = config.connections.rpcs.map(v => readMountedSecret(config, v.endpointSecretReference, 8192));
    assert.notEqual(urls[0], urls[1]);
    return Object.freeze(config.connections.rpcs.map((v, i) => {
      const rpc = createPublicChainHttpRpc({ id: `r5-${sha(v.id).slice(0,24)}`, url: urls[i], timeoutMs: s.rpc.timeoutMs,
        maxResponseBytes: s.rpc.jsonResponseBytes, fetchFn });
      return Object.freeze({ id: v.id, operatorReference: v.operatorReference, request: rpc.request.bind(rpc) });
    }));
  } catch { return deny(); }
}

/** No call on construction. Only the bounded, already-reviewed pilot transport
 * profile can be used; a changed model/profile needs its own review. */
export function createMountedProviders(installation, fetchFn = fetch) {
  try {
    const { config, evidence, operating } = installation, policy = evidence.assessmentPolicy, s = operating.operatingPlan.settings;
    assert.equal(policy.model, GROK_PILOT_PROFILE.model);
    assert.equal(policy.profileVersion, GROK_PILOT_PROFILE.id);
    assert.ok(Date.now() < Date.parse(GROK_PILOT_PROFILE.pricingChangesAt));
    const bearerToken = readMountedSecret(config, s.assessment.xCredentialReference);
    const apiKey = readMountedSecret(config, s.assessment.xaiCredentialReference);
    return Object.freeze({ identityResolver: new XApiIdentityResolver({ bearerToken, fetch: fetchFn,
      timeoutMs: Math.min(15000, policy.timing?.xCompletionMs ?? s.hosting.requestTimeoutMs) }),
      provider: new GrokAssessmentProvider({ apiKey, fetch: fetchFn, profile: GROK_PILOT_PROFILE,
        timeoutMs: Math.min(GROK_PILOT_PROFILE.timeoutMs, policy.timing?.grokCompletionMs ?? s.hosting.requestTimeoutMs) }) });
  } catch { return deny(); }
}

/** Only the typed authorization capability crosses into the guarded runtime.
 * It cannot send a transaction. JavaScript does not promise key erasure. */
export function createMountedAuthorizer(installation) {
  try {
    const { config, operating } = installation, declared = operating.operatingPlan.settings.custody.authorizer;
    const key = readMountedSecret(config, declared.signerSecretReference, 128);
    assert.match(key, /^0x[0-9a-fA-F]{64}$/);
    const account = privateKeyToAccount(key);
    assert.equal(getAddress(account.address), getAddress(declared.address));
    return Object.freeze({ address: account.address, signTypedData: account.signTypedData.bind(account) });
  } catch { return deny(); }
}
