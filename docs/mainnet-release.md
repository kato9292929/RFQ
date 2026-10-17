# mainnet 公開の手順

公開は **2026年11月**（Agave 4.4 で SIMD-0437 の rent 引き下げ最終段が mainnet に入った後）。
それまでは devnet で catalog quote を検証する（`log/devnet-catalog.md`）。`scripts/deploy-mainnet.sh` は 2026-11-01 より前は止まる。

上から順に実行し、各段の結果を確認してから次へ進む。どこかで止まったらそこで終える（やり直しは同じ段から）。

## 0. 事前（本人の操作。1回だけ）

| 何を | どこへ | 確認 |
| --- | --- | --- |
| mainnet RPC（Helius など `getProgramAccounts` を許すもの）の API キー | 環境変数 `MAINNET_RPC_URL`（URL 1 行） | — |
| `npm run wallet:new`（1回目 = deployer） | 表示された秘密鍵 → 環境変数 `MAINNET_DEPLOYER_KEYPAIR` | `docs/wallet.md` に deployer のアドレス |
| `npm run wallet:new`（2回目 = buyer） | 表示された秘密鍵 → 環境変数 `MAINNET_BUYER_KEYPAIR` | `docs/wallet.md` に buyer のアドレス |
| deployer に SOL | その日の `rent-check.ts` の deploy total + 0.3 SOL（docs/cost.md） | — |
| buyer に USDC $5 と SOL 0.01（今のレートのまま 2 回買うなら 0.02） | — | — |

2026-10-17 に作成済み（deployer `GUFvTMto5VBoiCMPjwKDhMbmcV2N5XNAVNaSPJVakiH9`、buyer `5HMizijyhNXLBbngmzYZe5j5rfWe7oddJS7PLrgzU9hd`）。Claude のセッション内では `--secret-file` でファイルに書き、環境変数へ写したらファイルを消す。

## 1. Secrets の確認

新しいセッションで、値を表示せずに有無だけ確かめる。

```bash
for v in MAINNET_RPC_URL MAINNET_DEPLOYER_KEYPAIR MAINNET_BUYER_KEYPAIR; do
  [ -n "${!v:-}" ] && echo "$v: set" || echo "$v: MISSING"; done
node -e 'for (const v of ["MAINNET_DEPLOYER_KEYPAIR","MAINNET_BUYER_KEYPAIR"]) { const a = JSON.parse(process.env[v]); if (a.length !== 64) throw v; }
  const { Keypair } = require("@solana/web3.js");
  for (const v of ["MAINNET_DEPLOYER_KEYPAIR","MAINNET_BUYER_KEYPAIR"]) console.log(v, Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env[v]))).publicKey.toBase58())'
```

表示された公開アドレスが `docs/wallet.md` の deployer / buyer と一致すること。

## 2. 残高の確認

```bash
RENT_RPC_URL="$MAINNET_RPC_URL" npx tsx scripts/rent-check.ts --balance <deployer のアドレス>   # rent + 0.3 SOL 以上で "balance OK"
solana -u "$MAINNET_RPC_URL" balance <buyer のアドレス>
spl-token -u "$MAINNET_RPC_URL" accounts --owner <buyer のアドレス>    # USDC (EPjFWdd5…Dt1v) が 5
```

その日の rent の値を `docs/cost.md` に追記する（計測日・レート・deploy total・1 RFQ あたり）。

## 3. デプロイ

```bash
CONFIRM_MAINNET=yes bash scripts/deploy-mainnet.sh
```

- 最初に rent を測り直し、deployer の残高が rent + 0.3 SOL 未満なら止まる。
- upgrade authority は deployer に残す（`--final` は付けない）。スクリプトが `solana program show` で authority を確かめる。
- Config（mainnet USDC、手数料 1%）を作り、`log/deploy.md` に program id・デプロイ tx・authority・Config・treasury を追記する。
- README の「Upgrade authority」の表に program id / authority / デプロイ tx を記入する。

## 4. 最初の2回の購入

```bash
CONFIRM_MAINNET=yes bash scripts/catalog-mainnet.sh
```

固定（上書き不可）で、1 RFQ ずつ:

1. OSD `https://osd.x402jp.com/api/catalyst/NVDA` — 0.001 USDC
2. JIN `https://jin.x402jp.com/api/jin/series` — 0.01 USDC

支払い上限（1コール $0.01・1日 $0.50）はコードで固定。終了コード: 0 = 成立・検証済み、2 = quote なしで取消、3 = 支払い後に不合格 / not_delivered。

## 5. log/deploy.md に記録

2回それぞれについて、`log/YYYY-MM-DD.jsonl` から次を `log/deploy.md` に書く:

| 項目 | 出どころ |
| --- | --- |
| post_rfq / submit_catalog_quote / award / 支払い / record_fulfillment（または record_rejection）の tx | `step` が同名の行の `tx` |
| 結果（fulfilled / rejected / not_delivered） | buyer の最終行 |
| 支払い額と手数料 | `x402_payment_sent` / `award` |
| 所要時間 | `catalog_round` の `wall_seconds` |
| インデクサの検証結果 | `/fulfillments` または `/rejections` の `verified` |

## 6. サイトの catalog ラベル

mainnet で最初の catalog 購入が成立してから、`docs/index.html` の Records に mainnet の記録を足し、
`<span class="net-label" data-network="mainnet">mainnet</span>` と catalog ラベルを付ける。devnet の既存の記録はそのまま残す（devnet ラベル）。

第三者の売り手は、この2回の後に別の変更で扱う。
