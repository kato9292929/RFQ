#!/usr/bin/env bash
# Catalog quotes on DEVNET against a mock x402 seller that implements no RFQ API.
# Two rounds of the same RFQ (scenarios/catalog-local.json):
#   round 1: the facilitator (pass-through to x402.org) lands the transfer but tells the
#            seller settlement failed → seller answers 402 → buyer records not_delivered
#   round 2: normal → fulfilled
# Both rounds also log the over-cap path (0.02) and the free path (200) as skipped.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export NODE_USE_ENV_PROXY=1 CLUSTER=devnet RPC_URL=${RPC_URL:-https://api.devnet.solana.com}
export X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
export LOG_DIR=log RUN_DIR=run/devnet-catalog INDEXER_PORT=8787
export INDEXER_URL=http://127.0.0.1:8787 INDEXER_PUBLIC_URL=http://127.0.0.1:8787
export FACILITATOR_URL=http://127.0.0.1:8790
export CATALOG_FILE=test/catalog-local.json CATALOG_PATHS_FILE=test/catalog-paths-local.json CATALOG_PAY_HOSTS=127.0.0.1
export BUYER_KEYPAIR=.keys/buyer.json
case "$RPC_URL" in *mainnet*) echo "refusing: mainnet RPC"; exit 1;; esac
mkdir -p "$RUN_DIR"
for p in 8787 8790 8810; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && { echo "port $p in use"; exit 1; }; done

# the mock seller pays rent for its own USDC account
CS=$(solana-keygen pubkey .keys/catalog_seller.json)
if [ "$(solana -u "$RPC_URL" balance "$CS" --lamports | cut -d' ' -f1)" -lt 5000000 ]; then
  solana -u "$RPC_URL" transfer -k .keys/deployer.json --allow-unfunded-recipient "$CS" 0.01 >/dev/null
fi

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
FACILITATOR_UPSTREAM=https://x402.org/facilitator FACILITATOR_SIMULATE_SETTLE_TIMEOUT=1 \
  node --import tsx facilitator/src/server.ts > "$RUN_DIR/facilitator.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 30); do curl -sf $FACILITATOR_URL/supported >/dev/null && break; sleep 1; done
node --import tsx scripts/mock-catalog-seller.ts > "$RUN_DIR/mock-catalog.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8810/api/free && break; sleep 1; done
node --import tsx indexer/src/server.ts > "$RUN_DIR/indexer.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "$INDEXER_URL/health" >/dev/null && break; sleep 1; done

rc=0
for round in 1 2; do
  t0=$(date +%s)
  set +e
  BUYER_SCENARIO=catalog-devnet-round$round BUYER_SPEC_FILE=scenarios/catalog-local.json BUYER_MAX_PRICE=10000 \
    BUYER_RFQ_WINDOW_SEC=15 npx tsx agents/buyer/src/index.ts 2>&1 | tee "$RUN_DIR/buyer-round$round.log"
  r=${PIPESTATUS[0]}
  set -e
  echo "==== round $round exit=$r (0=fulfilled+verified, 3=paid+rejected/not_delivered) wall=$(( $(date +%s) - t0 ))s ===="
  [ "$r" = 0 ] || [ "$r" = 3 ] || rc=1
done
echo "---- /quotes?source=catalog ----"; curl -s "$INDEXER_URL/quotes?source=catalog"; echo
echo "---- /fulfillments ----"; curl -s "$INDEXER_URL/fulfillments" | head -c 1500; echo
echo "---- /rejections ----"; curl -s "$INDEXER_URL/rejections" | head -c 3000; echo
echo "---- /sellers ----"; curl -s "$INDEXER_URL/sellers"; echo
exit $rc
