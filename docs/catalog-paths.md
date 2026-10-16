# Catalog URLs vs paid paths: OSD and JIN

Checked 2026-10-16 with one plain GET per URL (no payment).

## What the x402 Endpoint catalog lists

| host | catalog URL | GET result |
|---|---|---|
| Onchain Stock Data | `https://osd.x402jp.com` | `200 text/html` (the site's top page), not a 402 |
| Japan Inflation Nowcall | `https://jin.x402jp.com` | `200 text/html` (the site's top page), not a 402 |

Both entries come from the catalog's `x402-inc` seed (`data/seed/x402-inc.json` in
kato9292929/endpoint), which records each product by its site root. Neither host serves
`/.well-known/x402` or `/llms.txt` (both 404), so the paid paths cannot be discovered from
the catalog URL alone.

## The actual paid paths

| URL | GET result | price (USDC) | network | payTo |
|---|---|---|---|---|
| `https://osd.x402jp.com/api/catalyst/{ticker}` (checked with `NVDA`) | 402, x402 v2, `exact` | 0.001 | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet) | `4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf` |
| `https://jin.x402jp.com/api/jin/series` | 402, x402 v2, `exact` | 0.01 | mainnet | same |
| `https://jin.x402jp.com/api/jin/movers` | 402, x402 v2, `exact` | 0.02 (above the $0.01 per-call cap, so never quoted) | mainnet | same |
| `https://jin.x402jp.com/api/jin/latest` | 200, free | — | — | — |

Asset for all of them: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. The OSD homepage
also links `/api/alpha/…`; it was not checked.

The buyer uses `agents/buyer/catalog-paths.json` to swap the catalog URL for these paths.

## Expected effect on x402 Seller Probe

If x402 Seller Probe measures each host at its catalog URL, both `osd.x402jp.com` and
`jin.x402jp.com` are expected to **fail `status_402`**: the URL answers 200 with HTML. This
describes our own catalog entries, not a fault in either API. Fixing it means changing the
catalog seed URLs to the paid paths above, in the endpoint repository; that change is not made
here. (This expectation is based on the GET results above; the seller-probe code itself was
not read for this note.)
