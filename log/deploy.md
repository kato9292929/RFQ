# Deploy log (append-only)

Devnet deployments of `rfq_market`. New sections are appended by `scripts/deploy-devnet.sh`;
existing entries are never edited. Program keypair / upgrade authority are local files
(`.keys/`, `target/deploy/`) and are not in this repository.

## Deploy 2026-10-09T18:16:09Z (devnet)

| item | value |
|---|---|
| program id | `7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp` |
| deploy tx | `2XMFaoK1V7jrkz5GugSMbxGKpugm8LCeV6jTri1iLdp1SDd1Gk69zg1Vgg3iCtzfebmAM83pEfrwwSui1hAmSj4b` |
| upgrade authority / config authority | `Aa8u2QRvHsVvFfZwUqmpwgQToXtood1mxM78qUUrkpcE` |
| config PDA | `AQRQvbXmV5LJ8aRF99wzGBgJiyEiXygJbdoEDJmU39kW` |
| initialize tx | `5RFhg5TvENubUmJQw7YgaoL2dkQ9gK6ijMsHkSQNCNfyytJfMdegKhbgAytms6mdXcN7KHhR1VBJFAiDEeZjuwkz` |
| treasury (USDC ATA) | `G4Xin7C6qqPaRSuiSQPq1sC5YJBCMjYrBG881DLsHJEk` (owner `2wmFDMaZCEnKwhKpEn48SPtfqXUzR7o2EiGkHrH7oaW7`) |
| fee_bps | 100 |
| usdc_mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle devnet USDC) |
| buyer | `9w47MgH5Ja3fWJBCjArnvhDFuTeLdyN7Y4CMdXFPKWwf` |
| seller1 | `7y1XACwq166zWahizwaPcoZNFSABcPRn7iLJGjensj5` |
| seller2 | `47xUekHp56wxvBLBdpDS6Kfo5hW41ZUTVctw1sJeEGKX` |
| x402 facilitator | https://x402.org/facilitator (network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` = solana-devnet) |

## E2E 2026-10-09T18:23Z (devnet) — verified: true

`scripts/e2e-devnet.sh`: sellers ×2 → 1 RFQ → 2 quotes → award cheapest → x402 (public facilitator https://x402.org/facilitator) → record_fulfillment.

| step | detail | tx |
|---|---|---|
| post_rfq | rfq `3TTB1mGXpShWdPjCsTg5B1AX553DqqEaALMfjoorgEKR`, max 0.100000 USDC | `2BCumtFkMkza6SWXLAWM3aiBVwvXawRN7jpgeb9GeYgTPtu9tw7JqNMjA7MFhQPZv74DanQrFDWdXSTCN6T5HTaf` |
| submit_quote | seller1 0.050000 USDC | `fpV3sbf2MSJF3XvSE48DasUvsV18PZFNtq9j38Qxqyvwik9gco7Fu6zQMNiz1sjh1Epva86wQ8spWiigQ184hhm` |
| submit_quote | seller2 0.035000 USDC | `38P7bzD19Tdyj3B7nFjg9mv1PNy9PE8Giasr1WFbDA5a26j2goS4Qw2q6J1SVfJ7QyuF9r2txEt4TY1Hdty6Q5DY` |
| award | seller2; fee 0.000350 USDC → treasury `G4Xin7C6qqPaRSuiSQPq1sC5YJBCMjYrBG881DLsHJEk` | `31ppdZEDTTxBKAr2e5A6wF3CLJ6XANpqnVZpehugUETd6NbVdiGsfuQw1BzQyrympFwVTKectjzmakzN7Q24RXsf` |
| x402 payment | transferChecked 0.035000 USDC buyer → seller2, fee payer = facilitator `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5` | `5AqbP6PsPW827MK9ZioWPkaj1ptBsQ4mzXidNMZimbpzWuW2jM1v6eUx1PRcW5472BNSrqMjz6ebZrLLP6YmmrXR` |
| record_fulfillment | response sha256 `6c32bfa9fc0560c22ff35fc75b9f1b76c3b99206b72c91fd55cab3e8cfea90fc` | `qoWDF6YxFeZh6RDVhjG3ENrZSDfTZskWzgaKDqnFXZynasvM7ZSaYpSup7Xf4fpghck4KuCdP83cLvRxZMdB3XW` |

Indexer `GET /fulfillments`: `verified: true` (seller +35000, buyer −35000 in mint 4zMMC9…, tx succeeded).
Also checked directly with `getTransaction` (jsonParsed).

Earlier aborted attempts (no quotes, cancelled, not claimed as settlements):
`GXfbMG1MbTR3KFPtwNFQXLxEGKWX9yj9Y7BNxrcmq5JC` (cancel `Vqg9mreuUKtudA5B1bAnqyGN5WPrUd8QdBtuNUx9FAe88C4x81ZRs92Na5ZojBv7gszfqDMPtnvC5kbSx9xssVp`),
`f6kiHA68i6bb6Tzd9DcidJrdc3rDVk4Y3A8WYDLS7pw` (cancel `3DJdpcr6kv9CrJgjjsQoFWrnpxNF31CYKTV57dUUQMyt87oW1kdUZjdJNd7kGWP6q9b7WwisgrEbZM6ij2ueXi3J`) —
a stale local-validator indexer was still bound to :8787, so sellers never saw them. Fixed in e2e-run.sh (processes run as `node --import tsx` so cleanup kills them; ports checked before start).

## Scenario runs 2026-10-10 (devnet) — own buyer + own 2 sellers

Same mechanism, varied specs (`scenarios/`). 4 fulfilled with `verified: true`, 2 ended with no trade (cancelled). This shows the mechanism behaving correctly as the spec changes; it is not external demand.

| scenario | rfq | quotes | outcome | award tx | x402 payment tx | fulfillment / cancel tx |
|---|---|---|---|---|---|---|
| single-match-seller1 | `DEu7KWKzjqCxZVoYSKEcGXFrLQwsSbyZyYc4SgQdeXXx` | 7y1XAC=0.03 | fulfilled 7y1XAC @ 0.030000, fee 0.000300, verified=true (declined: seller2: no offer for category=rankings fields=top_hosts) | `2ZV4Lkn8Q9QvVDdaYLDmHf1FTd8pLttYvRfNhmWSu5wefkuHJKiWReBEBVn6CEnGiToSGUXS3oLDGKPcvNSjebZx` | `2sAmUVnWHEvBgGWyQw4cm8FoZuPvhFEfVqcZW6oUV9coN1Bz4SydQtt7Uvp2Ft3Tqebs99yPqK155eAjE5aLTjHf` | `2DCotHpCrvnp6xx6FxgrEPpbmn123uFidwYTugp8YLZMzsk26ZNseLrXVrJQ4unoYipnFkviSHgWAzgoiLaYTZN` |
| single-match-seller2 | `CBm9Xux3YD8NLXKcwvN3s2nxWzEMGVeJVP1sr64fG6dw` | 47xUek=0.02 | fulfilled 47xUek @ 0.020000, fee 0.000200, verified=true (declined: seller1: no offer for category=providers fields=first_party_providers) | `2dC4fbbG2PRN1Jb9tY8nbszoCeNShYWQcqLwAyNPVdVAHBT96gv5yq8B6aGdxMHNbTS7eYLkiWBiKfU7Nr1QoWey` | `3Gd4crr4uE7USuTvjywRpt12fBbRdM3VFLFKPgd91miMrfyvZR3TihKgg4nvgWqvYu78zeSHfW5YTaNxfBk1ztM7` | `2gkEP6aAiHReXPVAfEt4CcUBM8EiahKygCFKkWip13zxJhxVioPj9hxDsBHQ4wRRbH3utFhixj3qqupXgwf2GR36` |
| no-match | `HJsDycRozgnCzgwLJvdN7yisawwrWorMYt5LHScPoG9q` | 0 | cancelled (declined: seller1: no offer for category=weather fields=temperature; seller2: no offer for category=weather fields=temperature) | — | — | `64SaEwWq2hBwuqrvj2VaQvtPRkutGG6mgzFi7wybiuDUztn9PPgTisCgZumcXAUR772toNZGrvMw6vcPcq6bYUMa` |
| tie-at-cap | `CgqFxVUg1hRj5M9k45tb8fRZjJjwyE1GkB2asSaXfVf2` | 47xUek=0.03, 7y1XAC=0.03 | fulfilled 47xUek @ 0.030000, fee 0.000300, verified=true | `2fgj9gLADhKmFcSQVvgjLYPWq3kXeCQx59B2d9gB92xWMYpcfP6yY72qhXumPmkd25kDDYB1UHdjyPiGeNXgbAa9` | `XTq5taFH6JvkDucj3XsNw6K3qQc9KhssWEtHeYwWRX7habZ1e6QhhbjdL2fdMuLYjFjTQLFQtWHEfbCTgJMWc9Z` | `L1PFdCyvukZhm1Vwpv7Fc1ERZAAjMcSBvf12k4wqqNiKLz2v2z1cLF3szh1CtHQchzDKeKEnhqRhcpduKJVMYH9` |
| field-subset | `HzoXppnnpBnh81svh5xTrd3geBYrruq3sXQx5x2M1NrT` | 7y1XAC=0.05 | fulfilled 7y1XAC @ 0.050000, fee 0.000500, verified=true (declined: seller2: no offer for category=market-data fields=endpoint_count,by_source) | `3WtE62MRmZHLjxeC6hHki22nWke1YbhnDLxqcgBbvC3dCpQstcjm6RLmkCV3TheCZVFmrxCLu1zM9GfZQFiAxmER` | `5zkUZiTQUqhSSxN9XnSWAjMPaZGbYga7Hnh9S7FHDRpqcYPZdDcnHKZ22itMzB5z7v6anp4AZb2hXf2wvvFVm1JB` | `49P15hYFqiXB7iNirxcWHsPBAGBNzBdfnBSSoST5T88jYzeLcZMQ72217urPpEAYtR9qTx6qPtb7KkaNiGx7FTUC` |
| stale-data | `8cAPx9FXa8hxYHmBfFTyPam8UKFoVDg8MFt1VtM9WoCq` | 0 | cancelled (declined: seller2: snapshot is 14.8h old > freshness_hours=1; seller1: snapshot is 14.8h old > freshness_hours=1) | — | — | `39YRuPNTLHTb7qWYzSazcAmRkbFEuUv9qbWUfJAW9zGs6p8hPfZ1a5btwEukF7BmVTbHDC7HMFuYbizppHv6gs9m` |

Indexer `/stats` after these runs (all devnet RFQs, incl. the 2 aborted on 10-09): `{"rfq_count":9,"quote_count":7,"by_status":{"cancelled":4,"fulfilled":5},"award_rate":0.556,"avg_awarded_price":"0.033000","fees_total_usdc":"0.001650"}`.
tie-at-cap: both sellers quoted the 0.03 cap in the same second; the buyer tie-break (earliest created_at, then pubkey) picked seller2.

## Upgrade 2026-10-10T05:36:35Z (devnet)

Same program id `7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp`; existing Config/Rfq/Quote/Fulfillment layouts unchanged.
Adds `record_rejection` (Rejection PDA ["rejection", rfq], rfq status 5 = Rejected), `declare_sla` / `record_latency` (Sla PDA ["sla", quote]).

| item | value |
|---|---|
| programdata before / binary after | 281568 / 333680 bytes |
| extend tx | `Extended Program Id 7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp by 53136 bytes` |
| upgrade tx | `4VMmTLd4j7GRc3NKMQeqXKzqEmCTufnn9b5KP2ArymGgYSpSCACndeg3d6JDmMdhtQHZxW5LzNmeHAHmuKHrqWbj` |
| git commit | `c4c4f2e` |

## Upgrade 2026-10-10T07:20:09Z (devnet)

Same program id `7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp`; existing Config/Rfq/Quote/Fulfillment layouts unchanged.
Adds `record_rejection` (Rejection PDA ["rejection", rfq], rfq status 5 = Rejected), `declare_sla` / `record_latency` (Sla PDA ["sla", quote]).

| item | value |
|---|---|
| programdata before / binary after | 334704 / 333680 bytes |
| extend tx | `not needed` |
| upgrade tx | `4cqCvamrqDd3VXpuP8K5oy7Vu2LrDSFnW7coweDdhw48zbz5XGXrj3EXWmjPdETpZYnB6Wg1wocgyqiYinfu5MuC` |
| git commit | `af5d8cd` |

## Phase B/C runs 2026-10-10 (devnet) — own buyer + own 2 sellers

After the first upgrade (`4VMmTLd4…`, rejection + SLA). Mechanism behaving correctly as the spec changes; not external demand.

| scenario | rfq | outcome | payment tx | record tx | SLA declared / measured |
|---|---|---|---|---|---|
| schema-reject | `CupWhK79fzeBq31gEH3MZZiKez9Au9sFRQjf6upPUQS9` | seller1 @ 0.03 → paid → **rejected `schema_mismatch`** (25 rows < minItems 50) | `56SsNK2ZTkNEs4pAk1SxvwKjFjXcdffstwPPEu2D9vwcbuH1ztdiSSAGo6KqPbeiQGEhLqCUwCkZr17HkgLPaURX` | `nrxtnKV6GNxPEJYvov2gcaz3cp2FBACcBewjBAcM9Gy5VufByrqHDMBuT9R1SqM8rD2PNR8kRy2X2rCW3mHzdjL` | 8000 / 1547 ms |
| schema-accept | `Ci88LibMuScYkLL3rR17pJbfGag7qsDqhT2GFooVefjC` | seller2 @ 0.035 → fulfilled | `5nr5gP75nbRcDrBodJqAGdVbUmAHUB751n1rWhWUZaPtuotqjQjS1XkhXa9tys5ad8GCJkAWnwAP35kx2rdQ3Xu9` | `537KP9xyX9EG2cC57sQmHDdCr8G4eommbhN7gxxuDoAZFm81n6HQEnQAdn19QXeJFsSjMtDnawbwFf2Ls2dW5zHy` | 30000 / 1801 ms |
| sla-tight | `FrCbj1exL7FEr2kZGXjMHZmAsYewY3stJWhZEKoYaB9H` | seller2 excluded (SLA 30000 > 10000) → seller1 @ 0.05 → fulfilled | `2aJqP7HfL1w7xwMFhrwiw95DofYXBHgrJfjmB8coRLmQxvxgfrJfrJDdfVSKKCb2nJCtQPfyDNRynww47DeAoZf8` | `4utxon9o8LPJkohPim84kjTxaq6gECjxE5Dgq22g4VAacb3zRgRGGYFk7hgxTjW8uNnA1M12r4MBnWxrB1em6T8h` | 8000 / 1592 ms |
| tie-at-cap | `7A6P3nfiwdsGBqhqJtZ81H1bKz4HpeRFffp4X9NfzCcv` | tie at 0.03 → `earliest_slot` (509439163 vs 509439167) → seller2 → **paid, not delivered** → rejected `not_delivered` | `3m5HanqgwGDgaXzHrv3LGbHS1xmBuZgAYXw9mgqsMDLbA3EjFvq9KxCPHhA5R4WAkPFbzhSGiy4ZAcAxuVpkLiFQ` | `5cts4511LQ4LhsmoLddpiTPLQy5LmPj2kWxhhimeVfZU886JYhLJQNuTqQeLxbZrB8NeFNdj7VZNC8ECmTfqaUpf` | not measured (nothing delivered) |

### Incident: paid but not delivered (tie-at-cap, rfq `7A6P3nfi…`)

- 05:45:42Z the buyer sent the paid request; the seller answered **HTTP 402 with an empty body**.
- 05:45:45Z (slot 509439578) the transfer buyer → seller2, 0.03 USDC, fee payer = x402.org facilitator `CKPKJWNd…`, **succeeded** (`3m5Hanqg…`).
- Cause (assessment): with x402 v2 exact on SVM the buyer signs the transfer and the facilitator pays the fee and submits it.
  The seller's middleware waits for the facilitator's `/settle` answer before returning the body. When submission→confirmation
  outlasts that wait, the seller returns 402 although the tx is already in flight and later confirms. No error in the buyer or
  seller logic: it is the gap between the settle wait and Solana confirmation time, surfacing as "paid, not delivered".
  This is structural to settle-before-response per-call payment; the market does not refund (no escrow), it records.
- Recorded on-chain after upgrade 2 (reason code 5 `not_delivered`). Because this run predates the buyer-signature logging, the
  payment was matched post hoc: buyer signed the tx (buyer signature `5KpyFq4k9zUFNLGUKazm8XbvR7JsQtqodB5HDnGe2vZP3KxayGLNLPr76nsC8mAR2iHpzCAWi1k2N5LkoXhoj4HH`),
  TransferChecked of exactly quote.price in the configured mint, authority = buyer, destination owned by the awarded seller,
  not cited by any other record. From now on the buyer logs its own signature (`x402_payment_sent`) before the paid call and
  matches the landed tx by that signature (the tx id is the facilitator's signature and is not known in advance).
- Indexer: `/rejections` → `not_delivered`, `verified: true`; a payment tx may back only one fulfillment/rejection.

`/stats` after this (all 13 devnet RFQs): fulfilled 7, rejected 2 (schema_mismatch 1, not_delivered 1), cancelled 4, open/awarded 0;
fees 0.003100 USDC. `/sellers`: seller1 fulfilled 3 / rejected 1 (schema_mismatch); seller2 fulfilled 4 / rejected 1 (not_delivered).

## Upgrade 2026-10-17T14:21:37Z (devnet)

Same program id `7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp`; existing Config/Rfq/Quote/Fulfillment layouts unchanged.
Adds `record_rejection` (Rejection PDA ["rejection", rfq], rfq status 5 = Rejected), `declare_sla` / `record_latency` (Sla PDA ["sla", quote]).

| item | value |
|---|---|
| programdata before / binary after | 334704 / 369456 bytes |
| extend tx | `Extended Program Id 7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp by 35776 bytes` |
| upgrade tx | `2jLRSsd1vENUoB9mZvWFKgDSFoKi3SGMXctuDGbcv4tkV9GWmw1vxqjiEvGfYNaeUn3cF4We1rScHZCrp1ZPzpjZ` |
| git commit | `7961e5d` |
