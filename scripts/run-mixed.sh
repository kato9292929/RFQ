#!/usr/bin/env bash
# One batch: records on DEVNET, payments in MAINNET USDC to real catalog sellers.
#   1  OSD  /api/catalyst/NVDA (0.001)        RFQ → catalog quote → award → mainnet payment → devnet records
#   2  JIN  /api/jin/series (0.01)            same; then, only if JIN sends a Delivery Receipt, re-send the
#                                              same payment header once and check: same body, no new charge
#   3  every third-party host whose latest Seller Probe paid verdict is 納品 (delivered), no input
#      required, ≤ $0.01: one RFQ each, same flow, paid in Solana or Base USDC as its 402 asks
#   4  mock catalog seller on devnet: paid → first delivery fails → same payment header → recovered
# Daily cap $0.50 (lib/catalog.ts): once the next payment would cross it, the rest waits for tomorrow.
# Results: log/YYYY-MM-DD.jsonl (append-only) and log/run-YYYYMMDD.md (scripts/run-report.ts).
#   CONFIRM_MAINNET=yes MAINNET_RPC_URL=... MAINNET_BUYER_KEYPAIR='[...]' MAINNET_BUYER_BASE_KEY=0x... bash scripts/run-mixed.sh
# BASE_RPC_URL defaults to the public https://mainnet.base.org.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CONFIRM_MAINNET:-}" = yes ] || { echo "refusing: set CONFIRM_MAINNET=yes (payments are in mainnet USDC)"; exit 1; }
: "${MAINNET_RPC_URL:?set MAINNET_RPC_URL}"; : "${MAINNET_BUYER_KEYPAIR:?set MAINNET_BUYER_KEYPAIR}"; : "${MAINNET_BUYER_BASE_KEY:?set MAINNET_BUYER_BASE_KEY}"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export NODE_USE_ENV_PROXY=1 NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
# records: devnet (program, Config, 1% fee in devnet USDC) — the program is not on mainnet
export CLUSTER=devnet RPC_URL=https://api.devnet.solana.com X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
export USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU BUYER_KEYPAIR=.keys/buyer.json LOG_DIR=log
export RUN_DIR=run/mixed INDEXER_PORT=8787 INDEXER_URL=http://127.0.0.1:8787 INDEXER_PUBLIC_URL=http://127.0.0.1:8787
DAY=$(date -u +%Y%m%d); BATCH="mixed-$DAY-$(date -u +%H%M)"
mkdir -p "$RUN_DIR/specs"
for p in 8787 8810; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && { echo "port $p in use"; exit 1; }; done

MAINNET_BUYER=$(node -e 'const {Keypair}=require("@solana/web3.js");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.MAINNET_BUYER_KEYPAIR))).publicKey.toBase58())')
DEVNET_BUYER=$(solana-keygen pubkey .keys/buyer.json)
BASE_BUYER=$(node --import tsx -e 'import("viem/accounts").then(m=>{const k=process.env.MAINNET_BUYER_BASE_KEY.trim();console.log(m.privateKeyToAccount(k.startsWith("0x")?k:"0x"+k).address)})')
echo "batch $BATCH  payers: Solana $MAINNET_BUYER, Base $BASE_BUYER  devnet record buyer $DEVNET_BUYER"
# devnet rent for ~50 RFQs (each ≈ 0.01 SOL): top the record buyer up from the devnet deployer
if [ "$(solana -ud balance "$DEVNET_BUYER" --lamports | cut -d' ' -f1)" -lt 700000000 ]; then
  solana -ud transfer -k .keys/deployer.json "$DEVNET_BUYER" 0.8 >/dev/null && echo "devnet buyer topped up"
fi
CS=$(solana-keygen pubkey .keys/catalog_seller.json)
[ "$(solana -ud balance "$CS" --lamports | cut -d' ' -f1)" -ge 5000000 ] || solana -ud transfer -k .keys/deployer.json --allow-unfunded-recipient "$CS" 0.01 >/dev/null

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
node --import tsx indexer/src/server.ts > "$RUN_DIR/indexer.log" 2>&1 & PIDS+=($!)
FACILITATOR_URL=https://x402.org/facilitator node --import tsx scripts/mock-catalog-seller.ts > "$RUN_DIR/mock-catalog.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "$INDEXER_URL/health" >/dev/null && curl -s -o /dev/null http://127.0.0.1:8810/api/free && break; sleep 1; done

npx tsx scripts/probe-targets.ts > "$RUN_DIR/targets.json"
spec() { # spec <file> <host> <url>...
  local f=$1 h=$2; shift 2
  node -e 'const [f,h,...u]=process.argv.slice(1); require("fs").writeFileSync(f, JSON.stringify({category:"catalog",catalog_match:{hosts:[h],urls:u,max_price_usdc:0.01}}))' "$f" "$h" "$@"
}
ITEMS=()   # "<n>|<label>|<spec>|<expected price>|<extra env>"
spec "$RUN_DIR/specs/01-osd.json" osd.x402jp.com https://osd.x402jp.com/api/catalyst/NVDA
ITEMS+=("01|osd|$RUN_DIR/specs/01-osd.json|1000|")
spec "$RUN_DIR/specs/02-jin.json" jin.x402jp.com https://jin.x402jp.com/api/jin/series
ITEMS+=("02|jin|$RUN_DIR/specs/02-jin.json|10000|BUYER_CONFIRM_REREQUEST=1")
i=3
while IFS=$'\t' read -r host url amount; do
  n=$(printf '%02d' $i); spec "$RUN_DIR/specs/$n-$host.json" "$host" "$url"
  ITEMS+=("$n|$host|$RUN_DIR/specs/$n-$host.json|$amount|"); i=$((i+1))
done < <(node -e 'for (const t of require(process.argv[1])) console.log([t.host,t.url,t.amount].join("\t"))' "$(pwd)/$RUN_DIR/targets.json")
n=$(printf '%02d' $i)
spec "$RUN_DIR/specs/$n-mock.json" 127.0.0.1 http://127.0.0.1:8810/api/flaky http://127.0.0.1:8810/api/expensive http://127.0.0.1:8810/api/free
ITEMS+=("$n|mock-devnet|$RUN_DIR/specs/$n-mock.json|0|CATALOG_PAY_HOSTS=127.0.0.1")
echo "${#ITEMS[@]} item(s)"

spent() { node --import tsx -e 'import("./lib/catalog.ts").then(m=>console.log(m.catalogSpentToday().toString()))'; }
for item in "${ITEMS[@]}"; do
  IFS='|' read -r n label specf price extra <<< "$item"
  name="$BATCH-$n-$label"
  if [ "$price" != 0 ] && [ $(( $(spent) + price )) -gt 500000 ]; then
    echo "==== $name deferred: daily cap \$0.50 would be crossed ===="
    node --import tsx -e "import('./lib/common.ts').then(m=>m.appendLog({actor:'operator',step:'catalog_round',scenario:'$name',deferred:'daily cap'}))"
    continue
  fi
  t0=$(date +%s)
  set +e
  env $extra BUYER_SCENARIO="$name" BUYER_SPEC_FILE="$specf" BUYER_MAX_PRICE=10000 BUYER_RFQ_WINDOW_SEC=8 \
    npx tsx agents/buyer/src/index.ts > "$RUN_DIR/buyer-$n-$label.log" 2>&1
  r=$?
  set -e
  secs=$(( $(date +%s) - t0 ))
  echo "==== $name exit=$r wall=${secs}s ($(grep -E 'outcome=|no valid quotes' "$RUN_DIR/buyer-$n-$label.log" | tail -1 | cut -c1-140)) ===="
  node --import tsx -e "import('./lib/common.ts').then(m=>m.appendLog({actor:'operator',step:'catalog_round',scenario:'$name',exit:$r,wall_seconds:$secs}))"
done
curl -s "$INDEXER_URL/fulfillments" > "$RUN_DIR/fulfillments.json"
curl -s "$INDEXER_URL/rejections" > "$RUN_DIR/rejections.json"
npx tsx scripts/run-report.ts "$BATCH" "log/run-$DAY.md"
echo "report: log/run-$DAY.md"
