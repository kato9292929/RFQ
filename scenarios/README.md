# Devnet scenarios

Each file is a buyer spec. `scripts/scenarios-devnet.sh` runs them in order against the
same two sellers (offers in `agents/seller/offers.seller{1,2}.json`). What each one exercises:

| file | max_price (USDC) | expected |
|---|---|---|
| single-match-seller1.json | 0.10 | only seller1 offers `rankings` → 1 quote (0.03), awarded |
| single-match-seller2.json | 0.10 | only seller2 offers `providers` → 1 quote (0.02), awarded |
| no-match.json | 0.10 | nobody offers `weather` → 0 quotes → buyer cancels |
| tie-at-cap.json | 0.03 | both list above the cap → both quote 0.03 → tie broken by earliest quote |
| field-subset.json | 0.10 | `by_source` is only in seller1's offer → seller2 declines, seller1 awarded at 0.05 |
| stale-data.json | 0.10 | freshness_hours=1 but the catalog snapshot is older → both decline → buyer cancels |

These are all our own buyer and sellers. They show the mechanism behaving correctly as the
spec changes (including no-trade outcomes), not external demand.
