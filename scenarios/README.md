# Devnet scenarios

Each file is a buyer spec. `scripts/scenarios-devnet.sh` runs them in order against the
same two sellers (offers in `agents/seller/offers.seller{1,2}.json`). What each one exercises:

| file | max_price (USDC) | expected |
|---|---|---|
| single-match-seller1.json | 0.10 | only seller1 offers `rankings` → 1 quote (0.03), awarded |
| single-match-seller2.json | 0.10 | only seller2 offers `providers` → 1 quote (0.02), awarded |
| no-match.json | 0.10 | nobody offers `weather` → 0 quotes → buyer cancels |
| tie-at-cap.json | 0.03 | both list above the cap → both quote 0.03 → tie broken by earliest creation slot; same slot → uniform random (see below) |
| field-subset.json | 0.10 | `by_source` is only in seller1's offer → seller2 declines, seller1 awarded at 0.05 |
| stale-data.json | 0.10 | freshness_hours=1 but the catalog snapshot is older → both decline → buyer cancels |
| schema-reject.json | 0.10 | requires `top_hosts` with `minItems: 50`; seller1 quotes on category/field names (it does not read JSON-Schema constraints), delivers its real 25 rows → buyer pays, then `record_rejection(schema_mismatch)` |
| schema-accept.json | 0.10 | integer/minimum constraints the real data satisfies → cheapest (seller2) awarded, accepted |
| sla-tight.json | 0.10 | `max_latency_ms: 10000`; seller2 declared 30000 ms → excluded; seller1 (8000 ms, dearer) awarded; measured latency recorded on-chain |

## Seller pre-quote checks vs buyer acceptance test

Sellers decide *before quoting* on: category, field names, data freshness. They do not
evaluate JSON-Schema constraints (`minItems`, types, ranges) — that is the buyer's
acceptance test after delivery. Both sides use one reason vocabulary (`lib/common.ts` `REASONS`):

| reason | seller decline (off-chain, `log/*.jsonl`) | buyer rejection (on-chain code) |
|---|---|---|
| category_unsupported | yes | — |
| missing_fields | yes | 1 |
| stale_data | yes | 2 |
| schema_mismatch | — | 3 |
| invalid_response | — | 4 |

A rejection is recorded after the x402 payment has settled: **there is no refund** (no escrow,
by design). What the market guarantees is a tamper-proof record of the award and of the
delivery outcome (fulfilled / rejected with reason), which feeds each seller's track record
(`GET /sellers`).

## Tie-break

Equal price → the quote whose creating transaction landed in the earlier slot. Same slot →
uniform random pick by the buyer, with candidates, slots and the random index written to the
`quotes_collected` log record. (The 2026-10-10 devnet tie-at-cap run predates this and used
`created_at` seconds then pubkey order; pubkey order was a placeholder — a vanity key would
win every tie.)

These are all our own buyer and sellers. They show the mechanism behaving correctly as the
spec changes (including no-trade outcomes), not external demand.
