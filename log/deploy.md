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
