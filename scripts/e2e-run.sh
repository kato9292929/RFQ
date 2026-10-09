#!/usr/bin/env bash
# Core E2E: start indexer + 2 sellers, run one buyer round, print /fulfillments.
# Expects env (RPC_URL, CLUSTER, X402_NETWORK, FACILITATOR_URL, ...) to be set by the caller.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_USE_ENV_PROXY=1
RUN_DIR=${RUN_DIR:-run}
mkdir -p "$RUN_DIR"
export INDEXER_PORT=${INDEXER_PORT:-8787}
export INDEXER_URL=${INDEXER_URL:-http://127.0.0.1:$INDEXER_PORT}
export INDEXER_PUBLIC_URL=${INDEXER_PUBLIC_URL:-$INDEXER_URL}

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_http() { for _ in $(seq 1 60); do curl -sf "$1" >/dev/null && return 0; sleep 1; done; echo "timeout waiting for $1"; return 1; }

npx tsx indexer/src/server.ts > "$RUN_DIR/indexer.log" 2>&1 & PIDS+=($!)
wait_http "$INDEXER_URL/health"

for i in 1 2; do
  port=$((8800 + i))
  SELLER_KEYPAIR=.keys/seller$i.json SELLER_OFFERS=agents/seller/offers.seller$i.json SELLER_PORT=$port \
    npx tsx agents/seller/src/index.ts > "$RUN_DIR/seller$i.log" 2>&1 & PIDS+=($!)
done
wait_http http://127.0.0.1:8801/health
wait_http http://127.0.0.1:8802/health

export BUYER_KEYPAIR=${BUYER_KEYPAIR:-.keys/buyer.json}
export BUYER_RFQ_WINDOW_SEC=${BUYER_RFQ_WINDOW_SEC:-150}
set +e
npx tsx agents/buyer/src/index.ts 2>&1 | tee "$RUN_DIR/buyer.log"
rc=${PIPESTATUS[0]}
set -e

echo "---- GET /fulfillments ----"
curl -s "$INDEXER_URL/fulfillments" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const f of JSON.parse(s)){console.log(`${f.rfq}  price=${f.price_usdc} USDC  payment_tx=${f.payment_sig}  verified: ${f.verified}`)}})'
echo "---- GET /stats ----"
curl -s "$INDEXER_URL/stats"; echo
exit $rc
