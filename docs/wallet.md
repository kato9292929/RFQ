# Wallets (public addresses only)

Secret keys are never committed. On mainnet they are passed to the scripts as environment
secrets (`MAINNET_DEPLOYER_KEYPAIR`, `MAINNET_BUYER_KEYPAIR`) and written to disk only while a
script runs.

## Mainnet

| role | address | notes |
|---|---|---|
| RFQ buyer | `3AYQzAfGZrTbQgRbXzXwDCRj3Hz1jzxAXPkZbQ6RqMG8` | New wallet for this market only. Separate from x402 Autonomous Agent, x402 Seller Probe and the earlier proof run. Pays the 1% fee and the per-call x402 payments. Created 2026-10-16. |
| deployer / program upgrade authority | written to `log/deploy.md` by `scripts/deploy-mainnet.sh` at deploy time | Keeps the upgrade authority (the program is not made immutable; see README "Upgrade authority"). |
| treasury owner | defaults to the deployer, or `MAINNET_TREASURY_OWNER` | Receives the 1% fee in USDC. |

## Devnet (hackathon records, 2026-10-09/10)

| role | address |
|---|---|
| deployer / upgrade authority | `Aa8u2QRvHsVvFfZwUqmpwgQToXtood1mxM78qUUrkpcE` |
| buyer | `9w47MgH5Ja3fWJBCjArnvhDFuTeLdyN7Y4CMdXFPKWwf` |
| seller1 | `7y1XACwq166zWahizwaPcoZNFSABcPRn7iLJGjensj5` |
| seller2 | `47xUekHp56wxvBLBdpDS6Kfo5hW41ZUTVctw1sJeEGKX` |
| treasury owner | `2wmFDMaZCEnKwhKpEn48SPtfqXUzR7o2EiGkHrH7oaW7` |
