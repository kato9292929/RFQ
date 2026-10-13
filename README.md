# rfq-market — エージェント間 RFQ 市場（Solana devnet・x402 per-call 決済）

買い手エージェントが「欲しいデータの仕様と上限価格」を Solana に RFQ として投稿し、売り手エージェントが見積もりを返し、
買い手が採択した相手にだけ x402 の per-call で USDC 決済して受領する、**買い手起点の価格発見市場**です。

既存の x402 は「売り手が価格を固定し、買い手が払う」一方向です。本件はその逆（買い手が条件を出す）をオンチェーンに置きます。
市場の約定記録（RFQ / Quote / Award / Fulfillment）は Anchor プログラムに、データ売買の決済本体は x402 に分離しています。

> devnet 専用。mainnet へのデプロイ・mainnet 資産の移動は行いません（スクリプトは mainnet RPC を拒否します）。

## 構成

```
programs/rfq_market/   Anchor プログラム（Config / Rfq / Quote / Fulfillment、6 命令、4 イベント）
tests/                 anchor test（正常系 + 異常系）
indexer/               getProgramAccounts + イベント購読 → HTTP/JSON（/rfqs, /fulfillments の決済検証など）
agents/seller/         RFQ 巡回 → 見積もり → x402 エンドポイント（@x402/express, exact, SVM, USDC）
agents/buyer/          仕様投稿 → post_rfq → 最安採択 → x402 で 1 コール支払い → record_fulfillment
facilitator/           ローカルバリデータ用の最小ファシリテーター（verify/settle のみ）。devnet では使わない
lib/common.ts          共通（PDA、ハッシュ、追記専用ログ）
idl/                   ビルド済み IDL と型
scripts/               deploy-devnet.sh / e2e-devnet.sh / e2e-localnet.sh ほか
log/                   追記専用の実行記録（deploy.md, YYYY-MM-DD.jsonl）
```

## フロー

1. 買い手が仕様 JSON（例 `{"category":"market-data","fields":["endpoint_count","host_count"],"freshness_hours":24}`）を `POST /specs` → SHA-256 と URL を得る
2. `post_rfq(nonce, spec_hash, spec_uri, max_price, deadline)`
3. 売り手は `GET /rfqs?status=open` を 60 秒間隔で巡回。仕様本体のハッシュを検証し、`category`/`fields`/鮮度が自分の定義（`agents/seller/offers.*.json`）に合えば
   `submit_quote(min(定価, max_price), sha256(endpoint_uri), endpoint_uri, expires_at)`
4. 買い手は deadline まで待ち、最安（同額なら先着）を `award`。**このときプログラムが買い手→treasury に `price * fee_bps / 10000` の USDC を CPI 転送**（テイカー手数料 1%）
5. 買い手が `endpoint_uri` に GET → 402 → 支払い署名付き GET。価格は quote.price と一致、payTo は採択売り手、資産は Config の USDC mint のみ許可（クライアント側ポリシー）。
   売り手は自分が採択されていない RFQ には 402 を出さず 409 を返す
6. レスポンス本文の SHA-256 と決済 tx 署名を `record_fulfillment` に記録
7. indexer の `GET /fulfillments` が決済 tx を RPC で照会し、**成功 tx で、Config の mint について買い手残高が quote.price 減り、売り手残高が quote.price 増えている**ときだけ `verified: true`

「実決済している」と言えるのは `verified: true` の fulfillment だけです。

## オンチェーン

| 命令 | 署名者 | 検証 |
|---|---|---|
| `initialize(fee_bps, usdc_mint, treasury)` | authority | fee_bps ≤ 10000、treasury は usdc_mint の token account |
| `post_rfq(...)` | buyer | deadline > now、spec_uri ≤ 200B、max_price > 0 |
| `submit_quote(...)` | seller | status == Open、now < deadline、0 < price ≤ max_price、expires_at > now、1 seller 1 件（PDA） |
| `award()` | buyer | has_one buyer、status == Open、quote ∈ rfq、quote 未失効、treasury == config.treasury、buyer_usdc の mint/owner。手数料を CPI 転送 |
| `record_fulfillment(payment_sig, response_hash)` | buyer | status == Awarded、quote == awarded_quote（payment_sig の内容は検証しない → indexer で検証） |
| `cancel_rfq()` | buyer | status == Open |
| `record_rejection(payment_sig, response_hash, reason_code)` | buyer | status == Awarded、quote == awarded_quote、reason_code ∈ 1..4 → Rejection PDA `["rejection", rfq]`、status = 5 Rejected |
| `declare_sla(max_latency_ms)` | seller | quote の seller、status == Open、now < deadline → Sla PDA `["sla", quote]`（見積もりと同じ tx で送る） |
| `record_latency(measured_latency_ms)` | buyer | status ∈ {Fulfilled, Rejected}、quote == awarded_quote、未記録 |

SLA と拒否は別 PDA に置いており、既存の Config / Rfq / Quote / Fulfillment のレイアウトは初版から変わっていません（アップグレード後も旧アカウントをそのまま読めます）。

**市場が保証するもの**: x402 は受領前に決済が終わる per-call 決済で、エスクローは置きません。したがって返金は保証しません。
市場が持つのは「誰に約定し、納品がどうだったか（成立／理由付きの拒否、申告 SLA と実測応答時間）」の改ざんできない記録で、
これが売り手ごとの実績（`GET /sellers`）になります。

**記録の限界（改ざんできないことと、中身が正しいことは別）**: 成立・拒否を書けるのは買い手だけで、売り手が反論を残す命令はありません。
- `schema_mismatch` / `missing_fields` / `stale_data` は、仕様（`spec_hash` がオンチェーン）と受領本文のハッシュ（`response_hash`）が残るので、本文を持つ者なら第三者が再検証できます。
- `not_delivered` は「届かなかった」という買い手の申告で、オンチェーンの裏付けは「送金が成立した」ことだけです。実際に未納品だったかは売り手側のログにしかありません。
  devnet の 1 件（rfq `7A6P3nfi…`）は自社の売り手なので、seller2 が 402 を返したログと照合済みですが、外部の売り手が相手なら買い手が虚偽の `not_delivered` を書く余地があります。
- 売り手による反対記録（納品済みの主張と本文ハッシュの提出）は未実装です。

**選定ルール**（買い手）: 仕様の `max_latency_ms` を満たす SLA を申告した見積もりのうち最安。同額なら見積もり作成 tx の slot が早い方、
同一 slot なら一様乱数（候補・slot・乱数インデックスをログに残す）。pubkey 順は使いません（vanity 鍵で同額を取り続けられるため）。

**売り手の品質条件**（買い手、任意）: 仕様 JSON に `min_probe_score`（0〜100）があれば、上の条件を満たした見積もりそれぞれについて
売り手のエンドポイントのホストで [x402 Seller Probe](https://github.com/kato9292929/seller-probe) の `GET {PROBE_URL}/scores/:host` を引き、
スコアが `min_probe_score` 未満の見積もりを除外してから採択します（同額の扱いはその後）。Probe に記録のないホスト（404）もスコアを示せないので除外（`probe_unscored`）。
Probe の API が応答しないとき（タイムアウト 5 秒・5xx）は除外せず `probe_unavailable` をログに残して従来どおり選びます。
照会結果・除外と理由は `log/*.jsonl` の `probe_filter` と `quotes_collected.excluded` に残ります。`min_probe_score` が 0〜100 の数でなければ RFQ を出す前に止まります。

**受領判定**（買い手）: JSON であること → `fields` が揃っていること → `freshness_hours` → 仕様の `schema`（JSON Schema, Ajv）。
売り手は見積もり前にカテゴリ・項目名・鮮度だけを判定し、Schema の制約は見ません。見送り理由と拒否理由は同じ語彙です（`scenarios/README.md`）。

`Expired`(4) はオンチェーンでは書き込みません。indexer が「Open・deadline 経過・有効な quote なし」を `effective_status: "expired"` として返します。

## indexer API

```
GET  /rfqs?status=open        受付中（Open かつ deadline 前）
GET  /rfqs/:pubkey            RFQ 詳細 + 全 quote（価格昇順）+ fulfillment
GET  /quotes?seller=:pubkey
GET  /fulfillments            payment_sig / response_hash / verified / 検証詳細
GET  /rejections              拒否（理由コード付き）。拒否でも決済は検証する（支払った上での拒否であること）
GET  /sellers                 売り手ごとの見積もり・採択・成立・拒否（理由別）・SLA 申告/実測/遵守・見積もったエンドポイントのホスト（endpoint_hosts。x402 Seller Probe が参考値として読む）
GET  /specs/:spec_hash
POST /specs                   受け取ったバイト列をそのまま保存し SHA-256 を返す
GET  /stats                   同じ分母（全 RFQ）で 成立／拒否／キャンセル の 3 列、平均約定価格、手数料累計
GET  /config, /health
```

## 動かし方

前提: Solana CLI（agave 4.x）、Anchor 0.32.1、Node 22。

```bash
npm ci
anchor build
# テスト（ローカルバリデータ）
anchor test             # 起動済みバリデータを使う場合: anchor test --skip-local-validator

# 鍵（.keys/ は gitignore 済み）
for k in deployer buyer seller1 seller2 treasury_owner; do solana-keygen new --no-bip39-passphrase -s -o .keys/$k.json; done
cp .keys/rfq_market-keypair.json target/deploy/   # プログラム ID の鍵

# ローカルで一式（テスト用 mint とリポジトリ内ファシリテーターを使用）
bash scripts/e2e-localnet.sh

# devnet
#  1) deployer に ~2.5 SOL（プログラム rent ≈ 1.43 SOL + エージェント用）
#  2) buyer に devnet USDC（https://faucet.circle.com → Solana Devnet）
bash scripts/deploy-devnet.sh     # デプロイ + Config 作成 + log/deploy.md 追記
bash scripts/e2e-devnet.sh        # 売り手 2 体 → RFQ → 2 quote → award → x402 → fulfillment → verified
SCENARIOS="schema-reject:100000 sla-tight:100000" bash scripts/e2e-devnet.sh   # scenarios/*.json を順に流す
bash scripts/rehearse-upgrade-localnet.sh   # devnet の現行バイナリを載せたローカルでアップグレードを予行
bash scripts/upgrade-devnet.sh             # 同じプログラム ID のままアップグレード（必要なら programdata を extend）
```

## x402 ファシリテーター

devnet では公開ファシリテーター `https://x402.org/facilitator` を使用。2026-10-09 時点の `/supported` に
`exact` / `solana-devnet`（v1）と `exact` / `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`（v2、solana-devnet の CAIP-2 表記）が含まれ、
feePayer は `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`。本実装は x402 v2（`@x402/*` 2.28）なので CAIP-2 表記を使います。
`facilitator/` はローカルバリデータでの E2E 用で、devnet の決済には使いません。

## カタログデータ

売り手のレスポンスは公開リポジトリ [kato9292929/endpoint](https://github.com/kato9292929/endpoint) のデータを読み取り専用で集計した
`agents/seller/data/catalog-snapshot.json`（生成元コミットを `source.commit` に記録）。`scripts/build-catalog-snapshot.mjs` で再生成でき、
`e2e-devnet.sh` は実行前に浅いクローンから再生成します（`freshness_hours` を満たすため）。endpoint リポジトリには何も書き込みません。

## やらないこと

mainnet、既存リポジトリ（endpoint / data402 / aa / x402-Interlock）の変更、Circle Wallets / World ID / ERC-8004 統合、売り手への支払いのオンチェーンエスクロー。
