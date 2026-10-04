# Pulse pricing decision report

Use with **PPCP v1** at the repository path `docs/pulse-pricing-protocol/README.md` and a dated intake. Replace all placeholders; record a decision only when the owner actually makes it.

## Decision and applicability

- Run and intake reference: `<path and UTC date>`
- Protocol, policy and core versions: `<versions and pin>`
- Report state: `<needs intake / provisional recommendation / ready for decision / decision recorded>`
- Recommendation: `<option and raw config, or no admissible option>`
- Concrete reason and tradeoff: `<measured behavior versus stated priorities>`
- Meaningful alternative and sacrifice: `<option and difference>`
- Can this config be applied to the intended collection: `<yes / no / unverified; route and reason>`
- Owner decision and date: `not recorded`
- Deployment or activation evidence: `none recorded by this report`

## Brief and evidence assessment

Summarize the measured free results, known access restrictions and friction, separate paid-interest evidence, and the uncertainty that matters. State why the intake is sufficient for the claimed report state. Do not invent a conversion rate or profitability estimate.

## Policy and numerical assumptions

- Initial ask and floor in ETH and exact wei: `<values>`
- Opening target and desired time: `<whole ask or premium; preference or hard bound>`
- Reference duration and actual pump limit: `<values and status>`
- Opening error limit and remaining operating bounds: `<values and status>`
- Contract check timestamps: `<deployment and deadline; UTC and Unix seconds>`
- Chain, release, pin and deployment route: `<references>`
- Preference order: `<explicit order; unknown if absent>`
- Cost inputs and market sources, with dates: `<values or unknown>`

## Complete candidate menu

Enumerate every pair within the declared policy. Keep rejected rows and label the reason; attach candidates rejected by contract or envelope checks in the same report or a linked appendix. State the enumeration domain and counts so "all options" has a precise meaning.

| Option | Exact k | Exact PTS | Actual opening quote and error | Time to opening target | Reference pump and first half-time | Constraint result | Evaluation |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| `<ID>` | `<wei·seconds>` | `<wei/second>` | `<ETH and %>` | `<seconds>` | `<ETH and seconds>` | `<pass / rejection reason>` | `<fit and tradeoff>` |

## Fixed scenario evaluation

Use the same assumptions for every candidate, including rejected candidates that are numerically evaluable. Quote values following a sale are distinct from the price that sale paid. A report cannot claim these scenarios passed while leaving the table unfilled.

| Option | First paid price | 100th hourly price and floor | Hourly quote 10 minutes later | 100th daily price and floor | Daily quote 10 minutes later | First price after 90 idle days | Immediate following quote | Quote 10 minutes later |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<ID>` | `<ETH>` | `<ETH>` | `<ETH>` | `<ETH>` | `<ETH>` | `<ETH>` | `<ETH>` | `<ETH>` |

Hourly and daily sequences assume the first mint at opening. The idle case assumes no paid mint until day 90. Explain any changed assumptions.

| Option | Chain burst assumptions | Burst prices and resulting floor | Quote after the burst | Additional intake scenario | Constraint violation or uncertainty |
| --- | --- | --- | --- | --- | --- |
| `<ID>` | `<block timestamps and count>` | `<values>` | `<elapsed time and ETH>` | `<assumptions and results>` | `<result>` |

## Selection and unresolved questions

Show which options violate hard limits, then compare admissible choices in the stated preference order. Explain the recommendation without a hidden score. If no option works, state the conflicting bounds and keep them unchanged until an explicit revision.

List missing evidence, unresolved cost or cadence assumptions, applicability issues, and any needed owner decision. State what would trigger a new run.

## Exact proposed configuration

Use decimal integer strings for all wei-based constructor fields. The values below are placeholders, not a deployment manifest.

```json
{
  "k": "<exact decimal integer>",
  "genesisPrice": "<exact decimal wei>",
  "genesisFloor": "<exact decimal wei>",
  "pts": "<exact decimal integer>"
}
```

Attach fresh pinned-core validation and the applicable release preflight evidence before claiming the report is ready to apply. Recording this config does not change an existing immutable collection.
