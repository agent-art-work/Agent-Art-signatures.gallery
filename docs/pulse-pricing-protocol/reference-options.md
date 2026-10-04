# Pulse pricing reference options

This is the **October 3, 2026 reference snapshot** for [PPCP v1](README.md). It is a worked comparison, not a completed launch decision or deployment preflight. The proposed envelope uses a 0.01 ETH initial ask anchor, 0.001 ETH floor, at most 1% opening error, at most 100,000 seconds to a 0.005 ETH quote, and at most 0.01 ETH actual pump after 100,000 seconds. k and PTS are exact integer powers of ten.

Pinned math: `pulse-core-v1.0.0`, commit `a08ec26e396b9d3e20ccebd8871f176368bcd713`. Numerical validation uses reference Unix timestamp **1790985600**, or **2026-10-03 00:00:00 UTC**. Recheck against actual deployment and deadline timestamps before use.

## Complete menu inside the reference envelope

All prices below are ETH. Reference pumps are exact for the 100,000-second duration. Opening and stress prices are rounded for display. First decay means time to the nominated whole-ask target 0.005 ETH before any paid sale. The reference half-time is the first halving of the added premium, not the whole quote.

| Option | k | PTS | Actual opening quote | Opening error | First decay seconds | Reference pump | First premium half-time seconds | Evaluation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A | 10^17 | 10^8 | 0.010090909091 | 0.909091% | 14 | 0.00001 | 10,000 | Smallest pump; very fast opening discovery. |
| B | 10^17 | 10^9 | 0.010090909091 | 0.909091% | 14 | 0.0001 | 1,000 | Same opening as A; ten times its pump and shorter persistence. |
| C | 10^17 | 10^10 | 0.010090909091 | 0.909091% | 14 | 0.001 | 100 | Fast opening; reference pump equals the initial floor. |
| D | 10^17 | 10^11 | 0.010090909091 | 0.909091% | 14 | 0.01 | 10 | Fast opening; ask-sized reference pump with very short persistence. |
| E | 10^18 | 10^9 | 0.010009009009 | 0.090090% | 139 | 0.0001 | 10,000 | Provisional fit for a few minutes of discovery and a small reference pump. |
| F | 10^18 | 10^10 | 0.010009009009 | 0.090090% | 139 | 0.001 | 1,000 | Same opening as E; ten times its pump and shorter persistence. |
| G | 10^18 | 10^11 | 0.010009009009 | 0.090090% | 139 | 0.01 | 100 | Same opening as E; one hundred times its reference pump. |
| H | 10^19 | 10^10 | 0.010000900090 | 0.009001% | 1,389 | 0.001 | 10,000 | About 23 minutes of discovery; floor-sized reference pump. |
| I | 10^19 | 10^11 | 0.010000900090 | 0.009001% | 1,389 | 0.01 | 1,000 | Same opening as H; ten times its pump and shorter persistence. |
| J | 10^20 | 10^11 | 0.010000090001 | 0.000900% | 13,889 | 0.01 | 10,000 | About 3.9 hours of discovery; large and persistent reference pump. |

All ten pass the stated numerical and envelope checks at the reference timestamp. The owner has not recorded acceptance of the proposed envelope or a final launch configuration. No demand forecast is attached to these evaluations.

## Fixed stress comparisons

The hourly and daily cases begin with a first paid mint at opening and contain 100 paid mints. The 100th price becomes the resulting floor. The idle case contains its first paid mint only after 90 days; its immediate following quote is not a prediction of what another buyer pays. Prices are rounded to nine decimals of ETH.

| Option | 100th hourly price and floor | 100th daily price and floor | Following quote after first sale at day 90 | Same quote 10 minutes later without another sale |
| --- | ---: | ---: | ---: | ---: |
| A | 0.010125738 | 0.010190936 | 0.001781263 | 0.001137375 |
| B | 0.010403241 | 0.010202837 | 0.009333346 | 0.001163412 |
| C | 0.011627692 | 0.010204194 | 0.101000013 | 0.001166402 |
| D | 0.012618736 | 0.010204413 | 0.101000013 | 0.001166680 |
| E | 0.010357297 | 0.011009275 | 0.008812629 | 0.002373755 |
| F | 0.013132326 | 0.011128290 | 0.084333462 | 0.002634116 |
| G | 0.025376837 | 0.011141860 | 1.001000129 | 0.002664022 |
| H | 0.013483782 | 0.020003564 | 0.079126286 | 0.014737550 |
| I | 0.041234069 | 0.021193709 | 0.834334619 | 0.017341155 |
| J | 0.044828907 | 0.110026728 | 0.782262842 | 0.138375479 |

The reference-duration cap does not cap all idle periods. For C and D, different target premiums produce the same immediate day-90 quote because the integer anchor offsets reach one or zero seconds; later behavior remains different. Use the core's zero-offset behavior rather than the continuous approximation in such cases.

This snapshot is intentionally not a full decision report: it has no real intake, chain-specific burst timestamps, hourly/daily post-sequence cooldown table, cost validation or application preflight. A future run must fill the report template rather than call this snapshot ready to apply.

## Why there are ten options

Exhaustive power-of-ten enumeration within the contract types and guards leaves four k values inside this envelope. k = 10^16 has a 10% opening error; smaller k values are invalid or less accurate. k >= 10^21 takes longer than 100,000 seconds to reach the target. The reference pump ceiling requires PTS <= 10^11. At the reference timestamp, the strict start-time check gives the following minimum power-of-ten PTS values within the selected grid:

| k | Minimum power-of-ten PTS | Permitted PTS values in the envelope |
| --- | --- | --- |
| 10^17 | 10^8 | 10^8, 10^9, 10^10, 10^11 |
| 10^18 | 10^9 | 10^9, 10^10, 10^11 |
| 10^19 | 10^10 | 10^10, 10^11 |
| 10^20 | 10^11 | 10^11 |

Thus 4 + 3 + 2 + 1 = 10. This count is specific to the prices, bounds, pin and timestamp. Power-of-ten coefficients alone do not imply ten possible configurations.

## Provisional configuration E

```json
{
  "k": "1000000000000000000",
  "genesisPrice": "10000000000000000",
  "genesisFloor": "1000000000000000",
  "pts": "1000000000"
}
```

Its actual opening quote is about 0.010009009009 ETH; it reaches 0.005 ETH after 139 quiet seconds. At the 100,000-second reference duration, its added premium is 0.0001 ETH with a 10,000-second first premium half-time. These are measured mathematical behaviors, not an owner-approved launch decision.
