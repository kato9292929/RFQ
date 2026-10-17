# 費用（rent）の実測

- 計測日: **2026-10-17**（UTC 14:28）
- 計測先: Solana mainnet 公開 RPC `https://api.mainnet-beta.solana.com`（genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`）
- 方法: `getMinimumBalanceForRentExemption(bytes)` を各サイズで呼ぶ（`npx tsx scripts/rent-check.ts`、`--json` で同じ値を JSON 出力）
- 現在のレート: **5,080 lamports/byte**（アカウントの 128 バイトのオーバーヘッドを含む。rent = (128 + bytes) × 5,080）
- プログラム: `target/deploy/rfq_market.so` = 369,456 バイト（catalog 命令入り、devnet upgrade 3 と同じバイナリ）
- バイト数は `programs/rfq_market/src/lib.rs` の `8 + INIT_SPACE`。devnet の実アカウント（52 件）のサイズと全種類一致することを確認した。

## アカウントごと（実測値）

| アカウント | バイト | rent（SOL） | 払う人 | いつ |
| --- | ---: | ---: | --- | --- |
| ProgramData（ヘッダ 45 + .so） | 369,501 | 1.877715320 | deployer | デプロイ時に1回 |
| Program | 36 | 0.000833120 | deployer | デプロイ時に1回 |
| Config | 107 | 0.001193800 | deployer | initialize で1回 |
| Treasury の USDC ATA | 165 | 0.001488440 | deployer | initialize で1回（無ければ） |
| Rfq | 343 | 0.002392680 | 買い手 | post_rfq |
| Quote | 333 | 0.002341880 | 売り手（catalog は買い手） | submit_quote / submit_catalog_quote |
| CatalogQuote（catalog の印） | 353 | 0.002443480 | 買い手 | submit_catalog_quote |
| Fulfillment | 177 | 0.001549400 | 買い手 | record_fulfillment |
| Rejection | 210 | 0.001717040 | 買い手 | record_rejection |
| Sla | 90 | 0.001107440 | 売り手 | declare_sla（任意） |

## デプロイ1回分

| 項目 | SOL |
| --- | ---: |
| ProgramData + Program + Config + Treasury ATA | **1.881230680** |
| 余裕分（手数料・再送） | 0.3 |
| **deployer に必要な残高** | **2.181230680** |

- `solana program deploy` はバッファに書いてから ProgramData に移すので、rent は一時的に二重にはかからない
  （ローカル validator で「rent + 0.3 SOL」だけ入れて同じバイナリをデプロイし、残高 0.297 SOL で完了することを確認済み）。
- 書き込みは約 360 トランザクション。基本手数料 5,000 lamports × 360 ≈ 0.0018 SOL に優先手数料が少し乗る程度で、0.3 SOL に十分収まる。
- `scripts/deploy-mainnet.sh` はデプロイ前にこの計測を毎回やり直して表示し、deployer の残高が「その時点の rent + 0.3 SOL」未満なら止まる。

## 1 RFQ あたり

| 経路 | 作られるアカウント | rent（SOL） |
| --- | --- | ---: |
| 売り手の quote → 成立 | Rfq + Quote + Fulfillment | 0.006283960 |
| catalog quote → 成立 | Rfq + Quote + CatalogQuote + Fulfillment | **0.008727440** |
| catalog quote → 不合格 / not_delivered | Rfq + Quote + CatalogQuote + Rejection | 0.008895080 |

- 別途トランザクション手数料（post_rfq・quote・award・fulfillment/rejection の4本 ≈ 0.00002 SOL + 優先手数料）。
- このプログラムにはアカウントを閉じる命令がない（記録を消さない設計）ため、rent は戻らない。上の額がそのまま 1 RFQ の固定費になる。
- 支払いそのもの（x402 の USDC と 1% の手数料）は rent とは別。

## SIMD-0437（rent の段階的引き下げ）

出典: https://solana.com/upgrades/reduced-rent

| 段階 | lamports/byte | mainnet | デプロイ一式（SOL） | 必要残高 = 一式 + 0.3 | catalog 成立 1 RFQ |
| --- | ---: | --- | ---: | ---: | ---: |
| 引き下げ前 | 6,960 | — | 2.577434 | 2.8774 | 0.011957 |
| 1 | 6,333 | 2026-09-03（epoch 1028） | 2.345243 | 2.6452 | 0.010880 |
| 2 | 5,080 | 有効（2026-10-17 実測） | **1.881231** | **2.1812** | **0.008727** |
| 3 | 2,575 | Agave 4.4（2026年11月予定） | 0.953577 | 1.2536 | 0.004424 |
| 4 | 1,322 | 同上 | 0.489564 | 0.7896 | 0.002271 |
| 5 | 696 | 同上 | 0.257743 | 0.5577 | 0.001196 |

- 段階 3〜5 の値は上の式（(128 + bytes) × レート）で出した見込み。実際にデプロイする日に `scripts/rent-check.ts` で測り直した値が正。
- 11月に最終段（696）まで有効になれば、デプロイ一式は今の約 1/7（≈ 0.26 SOL）、catalog 成立 1 RFQ は約 0.0012 SOL になる。
- feature gate: -1 `4a6f7o7iTcA8hRDCrPLkSatnt5Ykxiu36wo5p1Tt12wC` / -2 `61BtM7BkDEE8Yq5fskEVAQT9mYA8qCejJWoLe5apqg81` / -3 `Ftxb3ZKq7aNqgxDBbP7EonvR2RszZk9ctjdsTX38kQaz` / -4 `GsUBNYNDPdMLHPD37TToHzrzcNcjpC9w5n1EcJk5iTaM` / -5 `mZdnRh9T2EbDNvqKjkCR3bvo5c816tJaojtE9Xs7iuY`
  （`solana feature status -um <id>` で有効化を確認できる）

## 入金額の目安（mainnet 公開時）

- deployer: デプロイ当日の `rent-check.ts` の「deploy total」+ 0.3 SOL（今日の値なら 2.1812 SOL、最終段なら約 0.56 SOL）
- buyer: USDC $5 と SOL 0.01。SOL 0.01 で catalog 成立 1 RFQ（今日 0.0087 SOL）が1回分。最初の2回（OSD・JIN）を今日のレートで回すなら 0.02 SOL、最終段なら 0.01 SOL で約 8 回分。
