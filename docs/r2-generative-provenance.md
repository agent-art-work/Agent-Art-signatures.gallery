# R2 — saved Grok provenance on verified generative artwork

September 24, 2026. Implemented and verified offline. This checkpoint makes no
paid provider call, changes no active environment or historical assessment,
adds no schema/grants, and authorizes no deployment or activation.

## Delivered behavior

After canonical inclusion is verified, both **Confirming** and **Minted** detail
pages can show the existing saved assessment under the collapsed Provenance
section: assessor, exact saved model, assessment date, MBTI letter meanings,
preparation-time verified spelling/account ID and saved research sources.
Assessment, Artwork and Mint sections, the single amber Caveat and existing
handle/MBTI navigation are unchanged. No new personality rationale, confidence
score, hidden reasoning or current-runtime attribution is invented.

Chain-only recovery remains usable without private evidence. No record,
malformed/mismatched evidence or unavailable optional storage yields **Not
recorded**, not an inferred Grok claim. The wording explicitly says this is the
site's assessment record, **not a cryptographic signature from Grok**.

## Trust and disclosure boundary

1. The existing reader first checks fresh projection state and canonical
   inclusion, then verifies the collection/renderer and exact on-chain inputs,
   assessment commitment, original recipient and authorization commitment.
   Before inclusion, on stale/unknown state, or after a reorg, no private
   assessment read occurs and no result is disclosed.
2. `OpenMintRepository.getAcceptedAssessment` reads only the configured
   namespace, canonical handle and exact chain assessment digest, joining the
   original attempt with `state='accepted'`. It validates stored payload bytes,
   indexed identity/commitment and namespace provenance/policy. It does not
   consult generation policy, claim a job or invoke a provider/signer.
3. `generativeAssessmentProvenance` validates a copied assessment again and
   uses `verifyGenerativeInputs` to recompute the assessment/input bindings,
   requiring native X-verified Grok provenance and matching handle, verified
   case-preserved spelling, MBTI, renderer identity and input profile. A
   self-consistent replacement record is not enough to match a different mint.
4. Only six existing page-model fields are copied. No private assessment ID,
   request/code, provider response ID, receipt, cost/budget, session, prompt or
   free-form reasoning is spread into HTML or public APIs. X/Twitter research
   links are allowlisted, deduplicated and sorted; query/fragment data is removed.
   Existing escaping, HTTPS-only rendering, `noopener noreferrer` and
   `no-referrer` remain. No research URL is fetched for rendering.
5. The projection is checked again after enrichment. If canonicality/freshness
   changes, the entire detail read is rejected; optional evidence cannot revive
   a stale mint or turn a submitted hash into a reveal.

This is a trusted server-side join, not independent provider authentication or
a public assessment-import endpoint. A privileged database/server compromise
is outside that assurance. Chain commitments alone do not establish who made
an assessment. The original signer/provider workflow remains the authority.

## Availability and ownership

The optional source is captured at composition time in both the isolated local
and future-staging sites. Its deadline is at most one second and at most half
the remaining artwork-read lifetime. A monotonic elapsed-time check also
rejects over-budget results when an event-loop delay postpones the timer.
Timeout/cancellation aborts its signal; late completion cannot enrich an
already-returned page. Underlying database
work remains tracked until settled so shutdown cannot release its writer
prematurely, including optional database work started by a chain read after
drain began. Local site shutdown now also drains artwork work, as staging
already did. Database statement/lock limits remain unchanged.

No private evidence is needed for SVG, PNG, token metadata or sharing-image
reads. Their bytes/commitments are unchanged. Optional-source failure is soft
only while chain/projection verification remains available; failure of the
shared projection database or writer still fails closed. There is no claim that
the whole website survives losing its database.

No cache, refresh job, new paid request or automatic retry is added. Ordinary
subsequent page reads may retry the read-only lookup. Generation disabled and
provider-free restart still permit exact saved-provenance reads.

## Verification

All provider and chain data below are explicit test fixtures. No actual X/Grok
call, wallet extension, public chain transaction or billing acceptance occurred.

| Campaign | Result |
| --- | --- |
| Broad page/projection/sharing/repository/site regression, real disposable PostgreSQL and opt-in HTTP | 990 tests passed across 19 files |
| Repository PostgreSQL transactions | 19 passed, including namespace/digest/accepted-state isolation, disabled generation and writer restart |
| Staging site HTTP lifecycle | Complete rerun: 27 passed; the expanded full mint/provenance/provider-free-restart case also passed after the final monotonic deadline check |
| Focused sharing/artwork/provenance coverage | 227 passed, 24 opt-in PostgreSQL cases skipped in this command (covered by the broad run); 100% statements/lines/functions, 97.61% branches; per-file thresholds unchanged |
| New provenance mapper | 100% statements/lines/functions/branches |
| Typecheck, build, upstream renderer/slogan locks, RC1 release lock and whitespace | Passed; RC1 remains `candidate-not-approved` |

The initial site run had one fixture error: the restart test omitted the two
explicit `undefined` provider-dependency keys required by the existing strict
constructor. After fixing the fixture, the full site suite passed; no guard
was relaxed. The final focused rerun also covers the subsequently tightened
monotonic optional-read deadline.

Visual DOM CDP verification used disposable PostgreSQL, synthetic chain
responses, the actual site/client and a scripted wallet. The success flow
performs one mocked X lookup, one mocked Grok assessment, one signature and one
scripted wallet send. Restart/reload adds no provider/sign/send effect, reveals
only after verified inclusion and keeps galleries empty until finality. Source
links are not visited. Two expanded provenance screenshots were inspected:

- 1280×960, light: three sections, one Caveat, saved assessor/model/date/account
  and source; 14px body text, no horizontal overflow or failed page/asset request.
- 390×844, dark: the same facts wrap without horizontal overflow; safe source
  link, 14px body text and no private-field leakage.

Browser evidence/screenshots are ignored under
`.local/generative-renderer/staging-browser-provenance-{light,dark}.{json,png}`
and `staging-browser-evidence.json`. These contain synthetic records, not proof
of real Grok authorship. Temporary logs: `/tmp/sg-r2-broad.log`,
`/tmp/sg-r2-postgres.log`, `/tmp/sg-r2-site.log`, `/tmp/sg-r2-site-final.log`,
`/tmp/sg-r2-site-restart.log`, `/tmp/sg-r2-coverage.log`,
`/tmp/sg-r2-browser.log`, `/tmp/sg-r2-typecheck.log`,
`/tmp/sg-r2-build.log` and `/tmp/sg-r2-release.log`.
No hosted CI, complete application release campaign or independent review is
claimed. R7 must pin and verify the complete accumulated worktree.

## Next and model guidance

R3 is next: populated RC1 database backup/restore rehearsal, using disposable
databases only. Recommend **GPT-6 Astra · XHigh** for restore design and invariant
review; **Sol · High** is sufficient for test/runbook implementation. Continue
stating the recommendation per step; the user selected Astra · XHigh throughout
R2. [Official OpenAI reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning)
informs effort selection; these task recommendations are engineering judgment,
not automatic model switches. Visual DOM was used for rendered verification.
The user cancelled ntfy notifications for this work.

R8 still needs separately authorized real X/Grok acceptance and observed saved
evidence. R2 does not resolve the old paid-account failures or reopen approval.
