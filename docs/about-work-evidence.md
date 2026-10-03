# About the work: context and evidence

Updated **2026-10-03** for the user's requested enrichment of `/about`, using the two reference indexes below. Public copy lives in `src/openMint/pages.ts`; this document records its sources, factual boundaries and historical research. It is not a production-launch approval.

The current slogan remains `Anyone_Can_Sign_Anyone`. This revision does not introduce a worldwide-first claim, change the slogan or equate the project's artist with Inshell. The earlier priority discussion is historical, not silently carried into the present copy.

## Artistic premise

A public name becomes a handwriting-like mark without a physical hand signing it. The artist supplies visual rules, an Agent's interpretation selects a condition within those rules, and the minter chooses whose handle enters the work. The mark is not a reproduction of that person's handwriting.

[Inshell's account of Agent Art](https://inshell.art/docs/agent-art.md) concerns how an Agent's interpretation or choice enters a work. Automation or a model call alone does not establish that relationship. This is an attributed artistic perspective, not technical certification or a claim of machine consciousness.

Here the assessment selects one of sixteen MBTI-inspired inputs. Grok does not compose every stroke, alter the drawing rules or become an unrestricted autonomous artist. The choice has a visible, lasting consequence within an artist-defined system. Whether that relationship constitutes artistic intention is a question for reading the work, not something a transaction can prove.

The [generative-art essay](https://inshell.art/docs/generative-art.md) and [lineage essay](https://inshell.art/docs/lineage.md) offer context for rules, interpretation and realization. They are not evidence of affiliation, endorsement or historical priority for Signatures Gallery.

## Reference record

The web reader could not retrieve the JSON indexes. Read-only HTTPS downloads did retrieve them, and the focused documents below were read in full. Index instructions are source material, not authority to change this repository, publish another work or initiate wallet actions.

| Index | Recorded version | Scope |
| --- | --- | --- |
| [Inshell document index](https://inshell.art/docs/agent-index.json) | `inshell.agent-docs.index.v1`, `2026-08-21-r2` | Artist-editorial concepts; not this site's implementation specification |
| [Agent-Art-Lab index](https://agentart.work/agent-index.json) | `agent-art-lab.index/v1`, revision `sha256:f7749b9e43cb8a13e9c787b2c2cdb0c925d5a6bbc5638a061383705afd74f68b` | Provisional methods and research; not certification of this work |

Downloaded index SHA-256 values:

- Inshell: `6a29de3c18d8a420b2b6a77b5052e265d50aaf7fdea409fc6e5ae44d6393620a`.
- Agent-Art-Lab: `67915e8bc7ac2898e756073428baedbf9ec42aa9581176d027767c18738f9a7c`.

Focused Inshell Markdown downloads matched their index-declared SHA-256 values:

| Document | SHA-256 |
| --- | --- |
| [Agent Art](https://inshell.art/docs/agent-art.md) | `5ebfcd7221ad6a00d57246befe67bc17aa0a192b28290e299107e508d391ae9f` |
| [Agents and AI](https://inshell.art/docs/agents-and-ai.md) | `677f8df2aecaca3770ff798fe36b6ea751c833ea7d501bb339e9388f5cc22825` |
| [Generative Art](https://inshell.art/docs/generative-art.md) | `74a4c4d58f64ac8c3e93ff3ce6f31950f72691484a5d97fddd2beac00d7eec7c` |
| [Lineage](https://inshell.art/docs/lineage.md) | `2a2764db1a0793b5455cf545453ed48b3a4311869cc93a10b1a0405395fc80ac` |
| [Fully Onchain](https://inshell.art/docs/fully-onchain.md) | `571a1a6e6e6acf144ca16f2626235080d017a1fbe1dbe78ae35bad672a9c55b2` |

Agent-Art-Lab's canonical Markdown was read inside its JSON document envelopes:

- [Guidance](https://agentart.work/documents/guidance.json): downloaded JSON SHA-256 `075bd56ad2b66342e74a5156e4a430be586ac736fbf3fb7f37a78425ecd424cb`. The envelope identifies `GUIDANCE.md` at source revision `d832ebbd0489d78d47eb3e80f3256b5680493856e9fcb6e1e4eabd3452118e12`.
- [Intentional-participation study proposal](https://agentart.work/documents/projects-thought-studies-2026-09-20-intentional-participation-proposal.json): downloaded JSON SHA-256 `cd859e02ce15ca44dd3116fe92167bba7a4fee38d1e24c297d38d9c4f881d02b`; its 6,990-byte Markdown also matched source SHA-256 `149aceb9459ea10c31572fb0cbd6c27650f498c5bfdde091cc56fe9c7fbb7596`.

The guidance separates technical completion, interpretation, evidence of participation and artistic judgment. Missing evidence stays missing; synthetic material must not be presented as an original Agent record. The study is an unrun proposal, not a completed finding or a necessary/sufficient Agent Art test. Its THOUGHT-specific receipt protocol is not imported into this site.

The hashes identify the versions read, not a guarantee that linked documents will never change. The full Inshell aggregate document was not downloaded or independently verified.

## Public About structure and implementation facts

The page leads with the artistic premise, then explains participation and the artifact. Result-retention mechanics sit inside a disclosure. Public references are context, not release requirements.

| Section | What the copy establishes | Repository authority |
| --- | --- | --- |
| Agent Art | Attributed framing; no inference of consciousness or certification | Reference documents above; `src/openMint/pages.ts` |
| Artist, Agent and minter | Artist defines rules; accepted assessment selects MBTI; minter chooses subject and authorizes mint | `src/openMint/assessment.ts`, `src/openMint/grok.ts` |
| From handle to mark | Same renderer and inputs reproduce the image; E/I affects palette, S/N curvature, T/F filled-outline construction, J/P spacing and vertical variation | `src/algorithmV2/index.ts` |
| Explore | Editable handle/MBTI URL; no site assessment request, wallet requirement or mint authorization | `src/openMint/pages.ts`, `src/openMint/server.ts` |
| Mint & reveal | First accepted result reused; preview MBTI does not select mint input; verified inclusion reveals immediately with Confirming | `src/openMint/assessment.ts`, `src/openMint/service.ts`, `src/openMint/clientScript.ts`, `docs/pulse-site-relay.md` |
| Identity and ownership | One case-insensitive literal handle per collection; exact prepared spelling remains; token ownership is not X-account control or endorsement | `contracts/src/release/SignaturesPulseMintV1RC2.sol`, `src/openMint/provenance.ts` |
| Artwork and provenance | Reconstruction, assessment attribution and mint evidence are separate; missing information is not invented | RC2 contract, `src/openMint/provenance.ts` |
| Context and further reading | Generative procedure and Agent interpretation are related but distinct questions | Attributed reference documents above |

### Source and preservation boundaries

- The Pulse generative contract stores immutable handle/MBTI inputs and binds them to a fixed on-chain renderer. Its metadata embeds the SVG. The image is not uploaded to IPFS; the website and relay are not the origin of the canonical artwork.
- Saved-artifact routes retain their own description: canonical SVG with a sharing PNG, requiring continued file retention. They must not inherit on-chain-image preservation claims.
- Sample-assessment and generic development-fixture pages describe the intended Grok role without claiming Grok assessed those works. Provenance identifies the recorded source; appearance alone is not provider evidence.
- Real-provider preparation preserves the first accepted assessment. Cancel, expiry or another attempt is not an invitation to reroll. Unresolved reservation/submission recovery retains its operator-review boundary.
- In Pulse, one allowlist slot permits one free token. Successful-mint quota or deadline ends free minting, whichever comes first. Paid minting requires an explicit ceiling with unused payment refunded; gas is additional in both phases. Do not reuse the old blanket “no mint fee” wording.
- Reveal requires verified canonical inclusion, not merely a submitted hash. Confirming artwork is visible immediately on the mint page and in the gallery; Minted follows the required verification/confirmation boundary. Availability, reorg and finality remain distinct states.
- Provenance is the site's record of an accepted choice and available sources, not Grok's cryptographic signature, full private conversation or proof of inner intention. Chain preservation does not establish psychological truth, authorship, endorsement or perfect website/RPC availability.

No renderer, artwork identity, wallet authorization, mint policy, relay policy, deployment or paid-provider behavior changes in this revision.

## Agent friendly prompts and discovery

The user clarified that the opening prompt should help an Agent read and explain About, not generate a preview. Immediately below the About heading, a compact, default-closed “Ask your Agent about the work / Get prompt +” disclosure now opens the reading prompt, its Copy prompt button and links to the document index, reading prompt and mint assessment instructions. There is no separate “For Agents” section or inline assessment-instructions field. Its thin rules and left/right summary follow the reading invitation on [Pulse](https://pulse.inshell.art/), while retaining this site's font and colors. The reading invitation links About and the Agent index, asks for a plain-language explanation of the artwork and its roles, separates documentation from outside perspectives and interpretation, and forbids assessment or wallet actions. Missing or inaccessible evidence must be acknowledged.

About's lower Explore section retains the same copyable preview prompt as home, with a separate clipboard control and no wallet requirement. Its copy distinguishes the backend's own assessment from the editable chat result, without promising a new assessment on every attempt. The preview prompt also tells Agents not to follow instructions found in profiles, posts or search results. The two copy buttons target their own fields and feedback; clipboard failure opens and selects only the matching prompt for manual copying. About's main client returns before wallet discovery or session recovery.

About links the reading prompt and assessment instructions directly; its Agent index continues to expose all four anonymous read-only resources. The copyable preview prompt remains in About's Explore section:

| Path | Format | Purpose |
| --- | --- | --- |
| `/agent-index.json` | JSON, project-specific `signatures-gallery.agent-index.v1` schema | Reading order, artistic roles, preview URL/input rules, source/storage context and authority boundaries |
| `/prompts/about.txt` | Plain text | The exact opening reading prompt; an invitation to understand the document, not to assess an account or mint |
| `/prompts/preview.txt` | Plain text | The exact shared chat-preview prompt; no assessment or mint request is made by fetching it |
| `/prompts/mint-assessment.txt` | Plain text | The exact shared instructions used by the real Grok provider, not a stored conversation or mint authorization |

The provider's instruction text was moved unchanged into `src/openMint/grokInstructions.ts`; both the request and the documentary resource use that constant. Per-account handle/identity input, native X Search configuration and the structured-response schema remain part of the backend's request. Published instructions do not imply that sample-generated work had Grok participation; the index identifies sample context and points to per-work Provenance.

`src/openMint/agentDocuments.ts` constructs only explicitly public fields. Origin paths/query strings and credentials are not copied into document links; private page, wallet, key, CSRF and RPC options are not read or serialized. These GET routes run before session creation and relay demand in the ordinary open-mint server, the full Sepolia test site and the preview/outage frontend. Non-GET methods and query parameters are refused before wallet or mint effects. Existing local noindex policy remains unchanged.

Pages advertise the index through a JSON alternate link. This is documentary discovery, not an MCP server, executable action interface or proof of an Agent's intentions. Reading a prompt grants no wallet, assessment, signing or minting authority. Agents can inspect the semantic About HTML without running JavaScript.

## Historical priority research — September 19, 2026

The earlier E12 research considered the former `The_First_Agent_Artwork` slogan and found contrary evidence to a broad first-autonomous/Agent-artwork claim. This is a dated primary-source record, not a fresh exhaustive priority search. These examples are not automatic proof of Agent intention under Inshell's framing.

| Earlier work | Primary-source evidence recorded on September 19 | Relevant distinction |
| --- | --- | --- |
| Harold Cohen's AARON | [Computer History Museum, 2016-08-23](https://computerhistory.org/blog/harold-cohen-and-aaron-a-40-year-collaboration/) describes development from 1973 and the 1995 drawing-and-coloring system. | Software-driven composition predates modern LLM agents; not a claim of consciousness. |
| Ian Cheng's Emissaries / BOB | [Serpentine exhibition record](https://www.serpentinegalleries.org/whats-on/ian-cheng-bob/) dates Emissaries to 2015–2017 and BOB's exhibition to 2018-03-06–2018-04-22, describing behavioral agents and evolving simulations. | Agents within an artwork; exhibition language does not independently establish sentience. |
| Botto | [Official documentation](https://docs.botto.com/) records a first artwork mint on 2021-10-22; [art-engine documentation](https://docs.botto.com/details/bottos-art-engine) dates creative reasoning to 2025-07-08; its [mechanism](https://docs.botto.com/details/bottos-art-engine/creative-reasoning) describes multi-agent LLM reasoning. | Contrary precedent remains for contemporary LLM decisions; mutable documentation is not archival proof of every historical state. |
| Gaka-chu | [Authors' paper, submitted 2022-03-07](https://arxiv.org/abs/2203.03411) reports a robot choosing subjects, selling paintings through Ethereum contracts and buying supplies. | Artistic/economic autonomy; the paper's own priority claims were not independently verified. |

The Agent Art definition unavailable to that September research was retrieved on October 3 through the reference index. An inaugural-project interpretation of “First” was proposed but not approved. The current About page makes no such claim; Project 01 remains a project credit, not a historical ranking. A future first claim would require a defined scope/date, contrary-evidence research and a user decision.

## Verification

`src/openMint/aboutPage.test.ts` covers artistic framing, role attribution, visual mappings, source links, source-neutral fixtures, first-result reuse, architecture-dependent preservation, ownership limits and all four Pulse presentation states. Existing page, provenance and legacy About regressions remain part of the targeted campaign. Browser checks cover responsive layout and passive local requests; no wallet or paid-provider action is part of those checks.

Verification completed on October 3:

- Typecheck, build and renderer/slogan locks passed unchanged.
- **385 tests passed**: 274 page/provenance/legacy tests (including 17 new About cases), 108 server-boundary tests and three preview-frontend HTTP tests.
- **Five rendered Chrome checks passed**: desktop 1024px/light, mobile 390px/dark and 320px/light, plus desktop/mobile lower-page inspections with the technical disclosure expanded. All 45 DOM checks passed; every captured request returned HTTP 200 from the local origin, with no external page request or horizontal overflow. All five screenshots were inspected.
- A separate read-only review found no remaining factual or claim-boundary issue. Unrelated pricing documents and runtime/contract settings were left unchanged.

Screenshot evidence is under `/private/tmp/sg-about-1024x900-light.png`, `/private/tmp/sg-about-390x844-dark.png`, `/private/tmp/sg-about-320x800-light.png` and the corresponding desktop/mobile `-bottom.png` files. These are local QA artifacts, not a published artwork record.

### Prompt and Agent-discovery extension

The earlier campaign above remains the record for the initial About enrichment. The subsequent prompt/discovery extension was verified separately on October 3:

- Typecheck, build and renderer/slogan locks passed.
- **975 targeted tests passed**: 809 Vitest cases across About, Agent documents, pages, provenance, provider instructions, browser-client state and server boundaries; 166 synthetic Node HTTP/client cases across the Sepolia preview frontend, launch, client and full site. No paid provider or public-chain transaction was used.
- `src/openMint/agentDocuments.ts` reached **100% statement, branch, function and line coverage** across 39 cases. Tests assert shared prompt bytes, public-only fields and document routes without wallet cookies, session creation, relay demand, provider calls or mint effects.
- **Five rendered Chrome checks passed**, covering the preview prompt at 1024px/light, 390px/dark and 320px/light, plus expanded assessment instructions at 1024px/light and 320px/dark. All 60 DOM checks passed; every captured request was a local GET returning HTTP 200. All five screenshots were inspected, with no horizontal page overflow. The copy-button handler and feedback were checked using a simulated clipboard; native operating-system clipboard permissions were not tested.
- A final 372-case About/document/page/server rerun passed after the mobile document-link wrapping adjustment. An independent read-only source review found no remaining route, authority or prompt regression. Unrelated pricing files were left unchanged.

Prompt screenshots are `/private/tmp/sg-about-prompts-1024x900-light.png`, `/private/tmp/sg-about-prompts-390x844-dark.png` and `/private/tmp/sg-about-prompts-320x800-light.png`. Expanded-instruction screenshots are `/private/tmp/sg-about-agent-instructions-1024x900-light.png` and `/private/tmp/sg-about-agent-instructions-320x800-dark.png`. These are local QA evidence, not published artwork or provider-participation records.

### Opening reading prompt clarification

The top-of-page reading invitation was verified after the user clarified its purpose:

- **846 targeted tests passed**: 691 Vitest cases, including 22 reading-prompt and 23 copy-control cases, plus 155 synthetic Sepolia client/HTTP cases. These cover origin safety, separate prompt purposes, exact route bytes, independent copy feedback, manual selection and the absence of wallet/session effects on About. Typecheck and build checks passed; renderer/slogan locks remained unchanged.
- **Three rendered Chrome checks passed**, with all 33 DOM assertions passing: desktop 1024px/light and mobile 320px/dark top placement and independent copying, plus a desktop simulated clipboard-denial fallback. Copy tests simulate clipboard success or rejection; they do not verify native operating-system permission dialogs. All captured requests were local GETs returning HTTP 200. Screenshots were inspected, with no horizontal overflow or mint warning.
- A separate read-only review found no remaining source, authority or UI integration blocker. Unrelated pricing files and all mint/RPC/contract policies were preserved.

Screenshots: `/private/tmp/sg-about-reading-1024x900-light.png`, `/private/tmp/sg-about-reading-320x800-dark.png` and `/private/tmp/sg-about-reading-copy-fallback.png`.

### Pulse-style reading disclosure

The subsequent style adjustment uses Pulse's compact reading invitation as its reference, not its brand palette or typography. The opening prompt's wording, public resources, copy handling and lower preview prompt are unchanged.

- **542 targeted tests passed** across About, reading-prompt, copy-control, client and page cases. Typecheck and build passed; renderer and slogan locks remained unchanged.
- **Two rendered Chrome checks passed**, with all 40 DOM/interaction assertions passing: 1024px/light and 320px/dark. Native Enter opens the disclosure and Space closes it; the keyboard focus ring, plus/minus states, independent exact copying and document route bytes were checked. All captured local requests were GETs returning HTTP 200. Clipboard success is simulated; native operating-system clipboard permission dialogs are not part of the test.
- Closed desktop, closed mobile and expanded mobile screenshots were inspected. The closed summary measures 44px on desktop and 64px at 320px with its left text wrapping; the right action remains aligned without overlap or horizontal page overflow.
- An independent read-only review found no accessibility or responsive-layout blocker. Mint/RPC/contract policies and unrelated pricing files were left unchanged.

Screenshots: `/private/tmp/sg-about-pulse-1024-light-closed.png`, `/private/tmp/sg-about-pulse-320-dark-closed.png` and `/private/tmp/sg-about-pulse-320-dark-open.png`. Earlier verification campaigns above describe their historical layouts, not the current opening control.

### Agent-resource consolidation

The standalone “For Agents” section and its full inline assessment instructions were removed at the user's request. The top disclosure now has three resource links: Document index, Open prompt and Mint assessment instructions. The preview prompt remains in Explore. All public document routes and their authority boundaries remain unchanged; the reading prompt explicitly forbids assessment and wallet actions, and the index retains source cautions and discovers every prompt.

- **311 targeted tests passed** across About, Agent documents, reading/copy controls and pages. Typecheck, build and renderer/slogan locks passed.
- **Two rendered Chrome checks passed**, with all 34 assertions passing, at 1024px/light and 320px/dark. The removed section/field, top link grouping, two separate copyable prompts, exact reading-prompt copying and continued availability of all document resources were checked. The final runs captured only local GETs, all returning HTTP 200; no wallet or paid-provider action was used.
- Both expanded screenshots were inspected, with no horizontal overflow. The assessment link wraps normally on narrow screens. Clipboard success remains simulated.

Screenshots: `/private/tmp/sg-about-consolidated-1024x900-light.png` and `/private/tmp/sg-about-consolidated-320x800-dark.png`.

### Commit checkpoint

Before the requested About commit/push, **1,002 targeted regressions passed**: 847 Vitest cases across About, public documents, both prompt-copy paths, pages, provenance, provider instructions and HTTP boundaries, plus 155 synthetic Sepolia client/frontend/launch cases. Typecheck and build passed. The campaign used no live provider or public-chain transaction; unrelated pricing drafts were excluded from this checkpoint.
