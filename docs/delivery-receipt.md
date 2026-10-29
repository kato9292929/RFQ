# Delivery Receipt（この RFQ リポジトリでの実装）

未納品（not_delivered）を、同じ支払いでもう一度受け取り直すための仕組み。
Delivery Receipt の指示書の中身はこのリポジトリにないため、以下は RFQ 側の実装で置いた前提。
ヘッダ名と署名対象の文字列は `lib/receipt.ts` の1か所にまとめてあり、指示書と違えばそこだけ直す。

## 売り手（`scripts/mock-catalog-seller.ts`）

- 支払い ID = 決済 tx の署名（Solana の tx 署名。Base の場合は tx ハッシュ）
- 200 を返すとき、ヘッダ `Delivery-Receipt`（`X-Delivery-Receipt` も読む）に base64(JSON) のレシートを付ける

  ```json
  {"v":1,"payment_id":"<tx 署名>","network":"solana:…","resource":"<URL>","body_sha256":"<本文の sha256 hex>",
   "signer":"<ed25519 公開鍵 base58>","issued_at":"<ISO 時刻>","sig":"<ed25519 署名 base58>"}
  ```

  署名対象は次の各行を改行でつないだ UTF-8 文字列:
  `x402-delivery-receipt` / `v1` / network / payment_id / resource / body_sha256 / signer / issued_at
- 同じ支払いヘッダ（`PAYMENT-SIGNATURE`）が2回目に来たら、verify も settle もせずに、保存しておいた同じ本文と同じレシートを 200 で返す（`Delivery-Replay: 1` を付ける）。
  支払いヘッダの同一性は、支払い tx に入っている買い手自身の署名で見る
- 模擬売り手のパス: `/api/paid`（通常）、`/api/flaky`（決済後に1回目だけ 503、2回目で納品）、`/api/broken`（決済後に納品しない）

## 買い手（`agents/buyer/src/index.ts`）

- 200 にレシートが付いていれば、本文のハッシュ・署名・payment_id（自分の支払い tx）・network を検証する。
  結果は Fulfillment の記録と同じ tx の memo に `receipt: ok | bad | none` と `receipt_signer` として残す
- 有料の呼び出しが 200 以外で、支払いが着地していた場合（判定は従来どおり、支払い前に記録した買い手の署名を含む tx を探す）:
  - 相手が自社（OSD・JIN）か模擬売り手（127.0.0.1 / localhost）なら、同じ支払いヘッダでもう1回だけ取り直す（`lib/catalog.ts` の `retryAllowed`）
  - 取り直しが 200 → Fulfillment を記録。memo に `recovered: true` と1回目の HTTP ステータスを残す（「取り直しで回収」）
  - 取り直しも失敗 → not_delivered のまま Rejection を記録。memo に `retry: "failed"`
  - 第三者の売り手には、同じ支払いヘッダを二度と送らない（`retry: "not_allowed"` で not_delivered を記録）
- `BUYER_CONFIRM_REREQUEST=1`（自社ホストのみ）: 正常に届いたあと、同じ支払いヘッダをもう1回送って、同じ本文が返ること・残高が減らないことを確かめる。レシートを返さない売り手には送らない

## 記録との対応

プログラム（devnet）のアカウント構成は変えていない。Fulfillment / Rejection を作る tx に SPL Memo 命令を同梱し、
`{"rfq402":1,"pay_net":…,"payer":…,"receipt":…,"recovered":…,"retry":…,"first_status":…}` を載せる（`lib/payment-net.ts`）。
indexer はその tx の memo を読み、`/fulfillments`・`/rejections`・`/quotes`・`/sellers` に出す。

元の「届かなかった」ことの記録は、run log（`x402_paid_request_failed` → `x402_rerequest`）と、Fulfillment 側の memo（`recovered: true`, `first_status`）の2か所に残る。
同じ RFQ に Rejection と Fulfillment を両方置くことはプログラム上できない（状態が awarded の間に一方しか書けない）ため、回収できたものは Fulfillment だけになる。
