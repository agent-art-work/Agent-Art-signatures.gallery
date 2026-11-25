# Local curator encounter handoff

November 25, 2026. Local, synthetic slice for DEV review and integration. OPS
retains the hosted environment. No cloud, live Grok/model calls, SDK release,
merge, publication, deployment or chain calls were performed.

## Baseline and scope

This worktree starts at `1b29335d280e294a6c1b459e54e95c454f1bba70`.
The primary Sig checkout was at
`aa9f97b10152dcd3da112b85d4bd063c020165bb`. Its curve study was untracked.
The [source baseline manifest](curator-encounter-source-baseline.json) pins the
reviewed eight `src/candidates` modules, SQLite fixture adapter/tests, `PLAN.md`
and `docs/curve-editing-and-references.md`. Only those app modules and the
relevant synthetic test adapter were brought across. The original checkout,
recovery qualification sources and hosted packets were left intact.

The original geometry, constrained study rules, centerline renderer and legacy
commit/recovery mechanism remain the baseline. The study rules are not the
Artist's final released definition. Existing app routers, renderer locks,
SDK packages and mint paths are unchanged. The standalone local facade has
deliberately synthetic identities; it must not be mounted in a hosted router.

## Run and restore

With the normal repository development tools available (TypeScript and Node
with `node:sqlite`):

```sh
npm run test:candidates
npm run typecheck:candidates
npm run curator:local
```

The demo listens only on `127.0.0.1:39019`. To choose a free port:

```sh
npm run curator:local -- --port 0
```

Choose `NorthWindow` or `PaperHarbor` for a scripted proposal. Any other handle
demonstrates an incomplete encounter. Each demo server uses disposable primary
and archive databases and removes them on SIGINT/SIGTERM. No external source
URL is fetched by the app.

Generate an independent review packet into a **new** directory, then restore it
into fresh disposable SQLite stores:

```sh
npm run curator:fixtures -- --output .local/curator-review-fresh
npm run curator:restore -- --input .local/curator-review-fresh
```

The generator uses the authentic pre-refactor `/1` signed envelope and creates
a new `/2` candidate through `start`, `propose` and explicit curator `submit`.
It writes `current-v2.json`, `restore-packet.json` and separately captured
`baselines.json`. The packet includes fixture-only custody, cutoff and current
authority inputs. Its signing key and writer-exclusion callback are synthetic;
they establish no production custody or fencing authority.

The restore driver checks the persisted `receipt_json` against the source's
literal pre-restore bytes, recovers the receipt through the service, repeats the
exact submission, and compares original geometry/SVG, final SVG, edit,
Intention and ordered cited posts. It checks the legacy representation remains
without posts, then removes its temporary stores. Generating a fresh packet
creates new encounter IDs and receipts; it does not overwrite the pinned files.

## Encounter contract

1. `start_signature` accepts exactly `{handle}`. It returns one new Work and
   Encounter, the exact original geometry and SVG, and the edit rules.
2. Grok owns retrieval of accessible public posts authored by that handle,
   source selection, the curve edit and stated Intention. This slice substitutes
   explicit scripted returns. `propose_signature` requires `encounter`,
   `previousDigest: null`, `edit`, `intention` and an ordered `posts` array of
   `{url, author}`. URLs must be literal HTTPS X/Twitter status URLs whose
   reported author/path matches the handle. These structural checks do not
   establish retrieval, accessibility, authorship or model provenance.
3. An absent/empty qualifying source list cannot create a proposal. The
   encounter has no submit action. The fixture's incomplete screen offers a
   fresh encounter or another handle.
4. The first valid proposal is fixed. Its versioned digest binds Work,
   Encounter, exact handle spelling, rule/definition versions, original SVG and
   geometry hashes, edit, literal Intention, ordered cited posts and final SVG
   hash. Exact proposal replay returns the same result; a different edit,
   Intention, citation, citation order or revision attempt is rejected.
5. The authenticated review surface displays both SVGs, stated Intention and
   **Posts Grok cited**. Details contain the exact edit, rules, original geometry,
   SVG bytes and digest. The curator has no editing controls. The source links
   remain reported evidence.
6. The explicit review POST is `{action: "submit", digest, operation}`. For `/2`
   the operation is the Encounter UUID. Only the separately authenticated
   curator may invoke it. MCP has no advertised submit or approval tool for
   `/2`. Direct Agent submission is rejected. Same-origin/CSRF checks apply to
   browser POSTs. The role identity in the loopback facade is a fixture.
7. A submit binds the exact proposal and uses the existing atomic receipt,
   outbox, create-only archive/readback and projection gate. A missing archive
   returns `pending_archive`; status reads do not repair it. Exact retry uses
   the same operation and returns the original receipt. The study's existing
   write/recovery deadlines and revocations remain enforced.
8. Silence, review reads, **Save locally**, and **Decline** create no receipt,
   archive entry or gallery row. Saving permits a later distinct explicit
   submit. Decline blocks submission. **Do it again** retires an unsubmitted
   local proposal and starts a new Work/Encounter from that handle's original
   curve. An already submitted candidate stays immutable.

The anonymous local gallery reads saved handle/SVG/Intention bytes. Citations
are retained in the private proposal and archive; this slice does not decide
public research-source disclosure or curator attribution. No live gallery is
enabled. Current mint status retains the existing offline model only.

## Saved formats and compatibility

| Boundary | Legacy | New encounter |
| --- | --- | --- |
| `candidate_format` | `1` | `2` |
| Draft digest | `signatures-candidate-draft/1` | `signatures-candidate-draft/2` |
| Private envelope | `signatures-private-commit/1` | `signatures-private-commit/2` |
| Receipt | `signatures-local-candidate-receipt/1` | `signatures-local-candidate-receipt/2` |
| Act | `parsed-study-proposal/1` | `fixed-curator-proposal/2`, ordered posts |
| Submission | Agent after separate curator approval | Curator's explicit exact submit |
| Legacy source representation | `posts_json = NULL`; no invented citations | Exact ordered JSON posts |

The isolated SQLite fixture advances `user_version` from 2 to 3. The additive
migration adds `candidate_format` (default 1), `posts_json` and `local_state`.
It does not rewrite any existing draft, receipt or signed envelope. Unrelated
database application IDs and unknown fixture versions are rejected. This is
not an instruction to migrate a live store. D1 needs its own reviewed migration.

`verifyEnvelope` recognizes `/1` and `/2` signing domains and reconstructs the
original definition, exact render and digest before import. Unknown versions
and altered/re-signed inconsistent content fail closed. Legacy saved drafts
retain their approval form and known MCP submit/retry call on the successor
HTTP profile, although new encounters advertise no Agent submit capability.

The SQLite importer carries all three new fields. The older local D1 importer
has a fixed field list that silently loses them; applying that importer unchanged
to `/2` would lose links and incorrectly treat curator retries as legacy Agent
submissions. The [minimal successor D1 import patch](curator-encounter-d1-import.patch)
adds exactly those fields. It is supplied for DEV's isolated integration, not
applied to historical qualification or hosted packet sources. Old test harnesses
that intentionally exercise `/1` must construct `curveCandidates` with the fourth
argument `1`; the new default is `2`.

## Pinned review fixtures

Both fixtures are synthetic. The legacy fixture was captured from the unchanged
baseline before this refactor, including the actual receipt string and signed
archive record. The current fixture was generated through the new submission
path. Neither fixture has changed since the independent mixed-restore check.

| File | SHA-256 |
| --- | --- |
| `tests/fixtures/candidates/legacy-v1.json` | `c807fb7ad70aa1956275024814ac9ec616de8c2914d07fb2b87bc5f1c6773dcd` |
| `tests/fixtures/candidates/current-v2.json` | `71aa1987e744608921db4e5475e4b6302cd6538b220b04d763cb1643c67b8732` |

The legacy receipt string hashes to
`e177fab1eab952b228c9aba55e1921cb4db4d7f35c700657ec30252c0c0e471c`;
the pinned current receipt hashes to
`1047a94326319837cda8bcc516376247dd134c79a2736a74cb4cd2584f2c7a7f`.
`legacy-schema.sql` preserves the pre-refactor database schema for upgrade tests.

## Checks and remaining qualification

The local suite passes 25 checks: 10 retained legacy regressions and 15 encounter
checks. It covers substitution, fixed replay, role and origin denial,
incomplete/local-only outcomes, fresh attempts, lost acknowledgements, archive
outage/restart, concurrent exact retry, mixed restore, pinned envelopes and
additive legacy migration. Strict candidate-source TypeScript checking passes.
The isolated checkout has no installed full-app dependencies; no full-app build
or full repository suite is claimed.

A real loopback server plus isolated stable Chrome/headless rendering checked
1280×1200 and 390×1200 review pages: two loaded curves, two citations, zero
editable proposal fields and no horizontal overflow or failed page/asset
requests. Gallery readback showed one loaded submitted card, and the socket-level
submit retry returned the identical receipt. Screenshots were inspected. These
are isolated rendered-page observations, not physical-display or real-Grok
evidence. The owned server, temporary databases/browser profiles and UI claim
were cleaned up. Captured UI evidence stays under ignored `.local/`.

The separately reported independent DEV check restored the pinned `/1` and `/2`
archive into SQLite and local Workerd/D1, preserving literal receipt strings,
ordered links, authenticated review and exact retry. It required the supplied
three-field D1 importer change. A later isolated successor run passed the 25
legacy/curator checks together with six Workerd/D1 checks, including the new
curator path and old receipt reads. Historical/pinned sources were untouched.
The final source includes legacy MCP retry/form compatibility, concurrent submit
approval recovery and correct saved-then-submitted review copy. The
[final source checkpoint](curator-encounter-checkpoint.json) pins the exact
handoff for DEV to compare with that independent snapshot.

Before any real integration/release: DEV must review the final diff, restore
both fixtures and qualify the successor D1 schema/importer and legacy harnesses
together. The Artist's final versioned rules, Protocol's actual commit envelope
and receipt semantics, live Grok public-post retrieval and exact SVG display,
real separate curator authentication/explicit submission, provider costs,
independent archive custody/current authority/fencing and hosted Worker CPU
remain unqualified here. OPS owns provider/host configuration and deployment.
Live publication, SDK release, mint/chain activation and deployment retain their
existing separate authority.
