# Pulse pricing intake

Use with **PPCP v1** at the repository path `docs/pulse-pricing-protocol/README.md`. Enter a description in your own words first; the protocol extracts the fields and asks only for missing information. Replace placeholders with an observation, preference, hard limit or `unknown`. Zero means observed zero, not missing data.

## Run and description

- Run date and observation window in UTC: `<start and end>`
- Protocol and policy version: `PPCP v1; operating envelope proposed`
- Launch description and priorities: `<your words>`
- Current stage: `<planning / free observation / calibration / decision>`
- Intended decision date and why this evidence window is useful: `<description>`

## Release and application route

| Field | Value or evidence |
| --- | --- |
| Target release and core pin | `<release and source references>` |
| Chain and existing collection if any | `<chain; deployed / not deployed>` |
| Actual or intended deployment time and free deadline | `<UTC timestamps or unknown>` |
| Can the paid config still be applied | `<yes / no / unverified; reason>` |
| Route for using free observations | `<predeployment pilot / future delayed-finalization release / evaluate existing immutable settings>` |
| Current free policy revision and evidence | `<root/capacity/quota revision; source>` |

## Free mint evidence

The planning allocation is **1,024 free slots**. Record the effective chain configuration separately; the planning count is not proof of an installed quota. Duplicate wallets may own multiple slots.

| Measure | Observation and source | Limitation |
| --- | --- | --- |
| Eligible slots, effective quota and access window | `<values>` | `<restrictions or changes>` |
| Successful free mints and their timing | `<aggregate count or cumulative series>` | `<coverage>` |
| Distinct minting wallets and concentration | `<aggregate counts and concentration>` | `Wallets do not establish distinct people` |
| Eligible audience reach and traffic sources | `<measured reach or unknown>` | `<denominator and attribution>` |
| Preparation, wallet approval and confirmed-mint funnel | `<counts or unknown>` | `<where observation ends>` |
| Preparation failures, abandonment and transaction failures | `<separate counts or unknown>` | `<known friction>` |
| Return participation and organic sharing | `<measured observations or unknown>` | `<window and attribution>` |
| Price-specific paid interest or executed paid purchases | `<separate evidence or unknown>` | `<statement versus purchase>` |
| Campaign changes, eligibility changes or interruptions | `<timestamps and effects>` | `<comparable periods>` |

## Price behavior and constraints

| Input | Current baseline or supplied answer | Preference or hard limit |
| --- | --- | --- |
| Initial ask anchor | `0.01 ETH` | `Current band; confirm in this run` |
| Initial floor | `0.001 ETH` | `Current band; confirm in this run` |
| Opening target | `0.005 ETH before the first paid mint` | `Standard comparison benchmark` |
| Desired time to opening target | `unknown` | `<rough preference or exact bound>` |
| Reference cycle duration | `100,000 seconds` | `Policy comparison convention` |
| Preferred or maximum added premium at that duration | `unknown` | `<preference or ceiling; ETH or percentage with baseline>` |
| Desired paid cadence and bursts | `unknown` | `<hypothesis or observed paid data>` |
| Longest plausible quiet period | `unknown` | `<assumption and reason>` |
| Buyer total spending constraints | `unknown` | `<scope including gas and fees>` |
| Priority when faster discovery and smaller jumps conflict | `unknown` | `<explicit ordering>` |
| Other nonnegotiable limits | `unknown` | `<limits and evidence>` |
| Proposed v1 operating envelope | `<accepted / still proposed / revision requested>` | `Do not silently replace its bounds` |

## Costs and market context

- Observed gas cost, date, network and source: `<value or unknown>`
- Other buyer fees and source: `<value or unknown>`
- Project cost per preparation, accepted assessment and mint, with uncertainty: `<values or unknown>`
- ETH fiat conversion if relevant, quote time and source: `<value or unknown>`
- Comparable launches and current primary sources if used: `<references or unknown>`
- Paid demand assumptions that remain unverified: `<list>`

## Sufficiency assessment

- What decision the evidence supports: `<description>`
- Why the observation window and access conditions are meaningful: `<description>`
- Missing facts that would change the recommendation: `<list>`
- Missing preferences the protocol should ask about: `<list or none>`
- Readiness: `<needs intake / provisional recommendation / ready for decision / decision recorded>`

Do not infer paid conversion from the free sellout alone. Preserve unknowns and separate price rejection from preparation, wallet or transaction friction.
