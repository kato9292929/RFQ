# Wallets (public addresses only)

Secret keys are never committed. On mainnet they are passed to the scripts as environment
secrets (`MAINNET_DEPLOYER_KEYPAIR`, `MAINNET_BUYER_KEYPAIR`) and written to disk only while a
script runs.

## Mainnet

Created 2026-10-17 with `npm run wallet:new -- <role> --secret-file <path>` inside a Claude Code session:
each secret went to a 0600 file in the session's scratchpad (never printed), was copied into the
environment variable, and the file was deleted. Only the public addresses are in the repository.

| role | address | notes |
|---|---|---|
| deployer / program upgrade authority | <!-- wallet:deployer --> `5HMizijyhNXLBbngmzYZe5j5rfWe7oddJS7PLrgzU9hd` (created 2026-10-17) | Pays the program rent (docs/cost.md) and keeps the upgrade authority (not immutable; see README "Upgrade authority"). Secret: `MAINNET_DEPLOYER_KEYPAIR`. |
| RFQ buyer | <!-- wallet:buyer --> `GUFvTMto5VBoiCMPjwKDhMbmcV2N5XNAVNaSPJVakiH9` (created 2026-10-17) | New wallet for this market only, separate from x402 Autonomous Agent, x402 Seller Probe and the earlier proof run. Pays the 1% fee, the per-call x402 payments and the RFQ rent. Secret: `MAINNET_BUYER_KEYPAIR`. |
| RFQ buyer on Base | <!-- wallet:base_buyer --> `0xC343C622d816275efEF6639706Be14Bb32b4b868` (created 2026-10-29) | Pays catalog sellers whose 402 asks for Circle USDC on Base (EIP-3009; the seller's facilitator pays gas, so no ETH). Created with `npm run wallet:new -- --chain base`. Secret: `MAINNET_BUYER_BASE_KEY` (a `0x…` private key). |
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
