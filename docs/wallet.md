# Wallets (public addresses only)

Secret keys are never committed. On mainnet they are passed to the scripts as environment
secrets (`MAINNET_DEPLOYER_KEYPAIR`, `MAINNET_BUYER_KEYPAIR`) and written to disk only while a
script runs.

## Mainnet

Created with `npm run wallet:new` (run twice: deployer, then buyer). The script prints the secret
key once and does not save it; it writes only the public address below.

| role | address | notes |
|---|---|---|
| deployer / program upgrade authority | <!-- wallet:deployer --> 未作成 | Pays the program rent (docs/cost.md) and keeps the upgrade authority (not immutable; see README "Upgrade authority"). Secret: `MAINNET_DEPLOYER_KEYPAIR`. |
| RFQ buyer | <!-- wallet:buyer --> 未作成 | New wallet for this market only, separate from x402 Autonomous Agent, x402 Seller Probe and the earlier proof run. Pays the 1% fee, the per-call x402 payments and the RFQ rent. Secret: `MAINNET_BUYER_KEYPAIR`. |
| treasury owner | defaults to the deployer, or `MAINNET_TREASURY_OWNER` | Receives the 1% fee in USDC. |

`3AYQzAfGZrTbQgRbXzXwDCRj3Hz1jzxAXPkZbQ6RqMG8` (made 2026-10-16 inside a session) is retired: it was never
funded and is not used. The buyer above replaces it.

## Devnet (hackathon records, 2026-10-09/10)

| role | address |
|---|---|
| deployer / upgrade authority | `Aa8u2QRvHsVvFfZwUqmpwgQToXtood1mxM78qUUrkpcE` |
| buyer | `9w47MgH5Ja3fWJBCjArnvhDFuTeLdyN7Y4CMdXFPKWwf` |
| seller1 | `7y1XACwq166zWahizwaPcoZNFSABcPRn7iLJGjensj5` |
| seller2 | `47xUekHp56wxvBLBdpDS6Kfo5hW41ZUTVctw1sJeEGKX` |
| treasury owner | `2wmFDMaZCEnKwhKpEn48SPtfqXUzR7o2EiGkHrH7oaW7` |
