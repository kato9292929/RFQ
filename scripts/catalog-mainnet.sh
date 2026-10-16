#!/usr/bin/env bash
# One catalog-quote round on Solana MAINNET: refresh the x402 Endpoint snapshot (read-only
# clone), start the indexer, post one RFQ with catalog_match, record catalog quotes from
# the sellers' own 402 prices, award, pay once over x402, record the outcome.
#   CONFIRM_MAINNET=yes MAINNET_RPC_URL=... MAINNET_BUYER_KEYPAIR='[...]' bash scripts/catalog-mainnet.sh
# Payment limits are enforced in code: $0.01 per call, $0.50 per day (lib/catalog.ts), and only
# hosts in CATALOG_PAY_HOSTS (default: osd.x402jp.com, jin.x402jp.com) are paid.
cd "$(dirname "$0")/.."
. scripts/mainnet-env.sh
export RUN_DIR=run/mainnet INDEXER_PORT=${INDEXER_PORT:-8787}
export INDEXER_URL=http://127.0.0.1:$INDEXER_PORT INDEXER_PUBLIC_URL=http://127.0.0.1:$INDEXER_PORT
# First purchases: OSD /api/catalyst/{ticker} (0.001) and JIN /api/jin/series (0.01), one RFQ
# each (a single RFQ would only buy the cheaper one). Third-party hosts come after these two.
SPECS=${SPECS:-"scenarios/catalog-osd.json scenarios/catalog-jin.json"}
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; cleanup_keys; }
trap cleanup EXIT
export BUYER_KEYPAIR=$(write_key MAINNET_BUYER_KEYPAIR buyer.json)

SRC=${ENDPOINT_REPO_DIR:-run/endpoint-ro}
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull -q --ff-only || true; else git clone -q --depth 1 https://github.com/kato9292929/endpoint.git "$SRC"; fi
export ENDPOINT_REPO_DIR="$SRC"
echo "catalog snapshot: $(git -C "$SRC" log -1 --format='%h %ci')"

(exec 3<>/dev/tcp/127.0.0.1/$INDEXER_PORT) 2>/dev/null && { echo "port $INDEXER_PORT in use"; exit 1; }
node --import tsx indexer/src/server.ts > "$RUN_DIR/indexer.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "$INDEXER_URL/health" >/dev/null && break; sleep 1; done

rc=0
for SPEC in $SPECS; do
  name=$(basename "$SPEC" .json); t0=$(date +%s)
  set +e
  BUYER_SCENARIO=$name BUYER_SPEC_FILE="$SPEC" BUYER_MAX_PRICE=${BUYER_MAX_PRICE:-10000} \
    BUYER_RFQ_WINDOW_SEC=${BUYER_RFQ_WINDOW_SEC:-20} npx tsx agents/buyer/src/index.ts 2>&1 | tee "$RUN_DIR/buyer-$name.log"
  r=${PIPESTATUS[0]}
  set -e
  secs=$(( $(date +%s) - t0 ))
  echo "==== $name exit=$r (0=fulfilled+verified, 2=no valid quotes→cancelled, 3=paid+rejected/not_delivered) wall=${secs}s ===="
  node --import tsx -e "import('./lib/common.ts').then(m=>m.appendLog({actor:'operator',step:'catalog_round',scenario:'$name',exit:$r,wall_seconds:$secs}))"
  [ "$r" = 0 ] || [ "$r" = 2 ] || [ "$r" = 3 ] || rc=1
done
echo "---- /quotes?source=catalog ----"; curl -s "$INDEXER_URL/quotes?source=catalog" | head -c 2000; echo
echo "---- /sellers ----"; curl -s "$INDEXER_URL/sellers"; echo
exit $rc
