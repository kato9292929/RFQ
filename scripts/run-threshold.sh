#!/usr/bin/env bash
# min_probe_score on real RFQs: each catalog field (scenarios/threshold-categories.json) is one RFQ
# with several competing catalog quotes, run once per threshold (0 / 90 / 95 / 99), threshold-major.
# Records on DEVNET, the one awarded quote paid in MAINNET USDC (Solana or Base, as its 402 asks).
# A seller that refuses our payment on a network is remembered as (host, network) for the rest of
# the batch (BUYER_NET_FAILURES_FILE). Daily cap reached → quotes and award recorded, no payment.
#   CONFIRM_MAINNET=yes MAINNET_RPC_URL=... MAINNET_BUYER_KEYPAIR='[...]' MAINNET_BUYER_BASE_KEY=0x... bash scripts/run-threshold.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CONFIRM_MAINNET:-}" = yes ] || { echo "refusing: set CONFIRM_MAINNET=yes (payments are in mainnet USDC)"; exit 1; }
: "${MAINNET_RPC_URL:?}"; : "${MAINNET_BUYER_KEYPAIR:?}"; : "${MAINNET_BUYER_BASE_KEY:?}"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export NODE_USE_ENV_PROXY=1 NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
export CLUSTER=devnet RPC_URL=https://api.devnet.solana.com X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
export USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU BUYER_KEYPAIR=.keys/buyer.json LOG_DIR=log
export RUN_DIR=run/threshold INDEXER_PORT=8787 INDEXER_URL=http://127.0.0.1:8787 INDEXER_PUBLIC_URL=http://127.0.0.1:8787
DAY=$(date -u +%Y%m%d); BATCH="threshold-$DAY-$(date -u +%H%M)"
mkdir -p "$RUN_DIR/specs"
export BUYER_NET_FAILURES_FILE="$RUN_DIR/net-failures-$BATCH.jsonl"; : > "$BUYER_NET_FAILURES_FILE"
for p in 8787 8810; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && { echo "port $p in use"; exit 1; }; done
DEVNET_BUYER=$(solana-keygen pubkey .keys/buyer.json)
if [ "$(solana -ud balance "$DEVNET_BUYER" --lamports | cut -d' ' -f1)" -lt 500000000 ]; then
  solana -ud transfer -k .keys/deployer.json "$DEVNET_BUYER" 0.6 >/dev/null && echo "devnet buyer topped up"
fi
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
node --import tsx indexer/src/server.ts > "$RUN_DIR/indexer.log" 2>&1 & PIDS+=($!)
FACILITATOR_URL=https://x402.org/facilitator node --import tsx scripts/mock-catalog-seller.ts > "$RUN_DIR/mock-catalog.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "$INDEXER_URL/health" >/dev/null && curl -s -o /dev/null http://127.0.0.1:8810/api/free && break; sleep 1; done
curl -sSf -m 120 https://probe.x402jp.com/scores -o "$RUN_DIR/probe-scores.json" && export PROBE_SCORES_FILE="$RUN_DIR/probe-scores.json" \
  || echo "Seller Probe /scores unavailable: only our own hosts will be paid"
echo "batch $BATCH"

CATS=scenarios/threshold-categories.json
for T in $(node -pe "require('./$CATS').thresholds.join(' ')"); do
  for C in $(node -pe "require('./$CATS').categories.map(c=>c.name).join(' ')"); do
    specf="$RUN_DIR/specs/$C-$T.json"
    node -e '
      const [cats, name, t, out] = process.argv.slice(1);
      const c = require(cats).categories.find((x) => x.name === name);
      const hosts = [...new Set(c.urls.map((u) => new URL(u).hostname.replace(/^www\./, "")))];
      require("fs").writeFileSync(out, JSON.stringify({ category: "catalog", min_probe_score: Number(t), catalog_match: { hosts, urls: c.urls, max_price_usdc: 0.01 } }));
    ' "$(pwd)/$CATS" "$C" "$T" "$specf"
    name="$BATCH-t$T-$C"; t0=$(date +%s)
    set +e
    BUYER_SCENARIO="$name" BUYER_SPEC_FILE="$specf" BUYER_MAX_PRICE=10000 BUYER_RFQ_WINDOW_SEC=40 \
      npx tsx agents/buyer/src/index.ts > "$RUN_DIR/buyer-$T-$C.log" 2>&1
    r=$?
    set -e
    secs=$(( $(date +%s) - t0 ))
    echo "==== $name exit=$r wall=${secs}s ($(grep -E 'outcome=|no valid quotes|awarded, not paid|no landed payment' "$RUN_DIR/buyer-$T-$C.log" | tail -1 | cut -c1-120)) ===="
    node --import tsx -e "import('./lib/common.ts').then(m=>m.appendLog({actor:'operator',step:'catalog_round',scenario:'$name',threshold:$T,category:'$C',exit:$r,wall_seconds:$secs}))"
  done
done
curl -s "$INDEXER_URL/sellers" > "$RUN_DIR/sellers-$BATCH.json"
npx tsx scripts/run-threshold-report.ts "$BATCH" "log/run-$DAY.md" "$RUN_DIR/sellers-$BATCH.json"
echo "report: log/run-$DAY.md"
