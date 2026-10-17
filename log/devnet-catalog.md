# devnet: catalog quote E2E（模擬売り手）

- 実施日: 2026-10-17
- ネットワーク: Solana devnet（`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`）、USDC devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- プログラム: `7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp`（catalog 命令入りに upgrade 済み。`log/deploy.md` の devnet upgrade 3、オンチェーンのハッシュがローカルビルドと一致）
- 実行: `bash scripts/catalog-devnet.sh`（終了コード 0）
- 模擬売り手: `scripts/mock-catalog-seller.ts`（127.0.0.1）
  - `/api/paid` 402・0.005 USDC（5000）
  - `/api/expensive` 402・0.02 USDC（20000）
  - `/api/free` 200（402 を返さない）
- 買い手の上限: `BUYER_MAX_PRICE=10000`（1コールの上限 $0.01 と同じ。上限そのものは変更していない）
- facilitator: `facilitator/src/server.ts` の pass-through モード（`FACILITATOR_UPSTREAM=https://x402.org/facilitator`）。
  1回目だけ `FACILITATOR_SIMULATE_SETTLE_TIMEOUT=1` で「送金は着地したが売り手には失敗と返る」状態を再現した。
- catalog seller PDA（host `127.0.0.1`）: `BmrmxC4uAmtUv6oHEdDxFMaRkjVgmMBc1jNvvwBgXnxr`
- 実行ログ: `log/2026-10-17.jsonl`（`catalog-devnet-round1` / `catalog-devnet-round2`）

## 結果（4系統）

| 系統 | 確認内容 | 記録 |
| --- | --- | --- |
| 成立（fulfilled） | round 2: `/api/paid` に catalog quote → award → x402 支払い → 応答を検収 → `record_fulfillment` | 下記 round 2 |
| 上限超え（over-cap skip） | 両 round: `/api/expensive` は `price 20000 > cap 10000` で quote を出さず見送り | `catalog_402` ログ（skip） |
| 無料パスの見送り（free-path skip） | 両 round: `/api/free` は `HTTP 200 (not 402)` で見送り | `catalog_402` ログ（skip） |
| not_delivered | round 1: 送金は着地したが応答なし → 買い手が自分の署名で着地を検出 → `record_rejection(not_delivered=5)` | 下記 round 1 |

インデクサの `/quotes?source=catalog`、`/fulfillments`、`/rejections`、`/sellers` でも同じ内容を確認した（`verified: true`）。

## round 1（not_delivered）

| 段階 | tx / 値 |
| --- | --- |
| post_rfq | `StSuk8inzSVbibsSBDtiTqsNCLbUu2ZQ8D7cuo96njYsrWF3H7EkMRWKyYY6xxmXy3S51bkBCMjhrz5PZYcMddT` |
| catalog_402 | paid: ok 5000 / expensive: skip（price 20000 > cap 10000）/ free: skip（HTTP 200） |
| submit_catalog_quote | `5JRKudu3rrcApVicXK5NBF1rFHzhxc3CUYSJauncX8sWHUNQqTTTTgj2kjdfGMATHwCb292wpkMQMY3Wk1nnRR36` |
| award（fee 50） | `3ADvbsbJeZAbXojzqdYzEjNQMEDatxCRmaTfcwhnVjJKPxBT2B7MwbWQtTETYC7E8BBfSaPwNxmR5cagzoC5hBvz` |
| 買い手の署名 | `3eAa3i2anZP6U6iyWEzYibTi5aFVGeBYJS2tZidaMwJw3SjSwUz77MM6HZfCwnhapqCLBxk8v2scHQP8Bw7XXxiu` |
| 有料リクエスト | 失敗（1,677 ms） |
| 着地した支払い tx | `JHJrvUy7uManXuhEycNtUcWSDJLTSHXo1P8cv1JfRaHM6S6rsH7g4vXwWHJk24bvcnbyiXuBK9eF1mqRTsMxdng` |
| record_rejection（not_delivered） | `4TRocK9eVt5pET5BjfoRsmYTB3LDfwHrTUxQc7YvDzbaaJYbv42Z8LaDN73oKxKwxBEXp7miYi84erMW8hR5uzhM` |
| インデクサ検証 | verified: true |
| 所要時間 | 28 s |

## round 2（fulfilled）

| 段階 | tx / 値 |
| --- | --- |
| post_rfq | `2p5WEP468AnwkRvZruPVLfJ63kQrDyqLWxLtkGUNCTurtb9q8msh1Yvzd8Exa7PsXe93dC9jC5xTfA8suSLWB5qS` |
| catalog_402 | paid: ok 5000 / expensive: skip（price 20000 > cap 10000）/ free: skip（HTTP 200） |
| submit_catalog_quote | `2wBQ7UxNyMHnH3JnB7cFMPacetuo2EE5ZTrjtBMfbJUTRwnEBogfBiuJhPp4cZkYgLpi9VTNc88CSzbyTM6u9gJE` |
| award（fee 50） | `5qUuRuAdzEBT5tzDxYdMLNzwNj3tCDuz4FVkNLBJr43zwQH959CygLCQTM7pRujmNzCx9b8bgzDaJdaPdSuCkZFt` |
| 買い手の署名 | `LT9RSiavSbhwHyntrNHFrbc9zGTK6LHnVjKAzzhnrdTZSYnEfTTNyP7Pce5159pr6odvwBCqZZERnzv42xWihzn` |
| 支払い tx | `3pS8AwqK95oMUnMmFjz9hAVuxoQRvH5cYokU6XUoQTGdwwk1gebRyeKQqadK2f1AWbeEdxWW9eTo1bYJXuSuwsCt`（4,725 ms） |
| record_fulfillment | `4kZ9DPMhWGMVBEY5siaps6s5AcbgJ1p1Hp1D6SGH1JNruLFM25D1RNGBoBQqViXtKeJiahzr9SZXeVykVAf5HLtG` |
| インデクサ検証 | verified: true |
| 所要時間 | 28 s |

Explorer: `https://explorer.solana.com/tx/<sig>?cluster=devnet`

## 補足

- 模擬売り手は自前のローカルサーバーで、第三者の売り手には一切リクエストしていない。
- 支払い額は 0.005 USDC × 2（devnet USDC）。上限（1コール $0.01・1日 $0.50）は変えていない。
