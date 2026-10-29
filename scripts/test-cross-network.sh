#!/usr/bin/env bash
# Records on one network, payments on another — the same split as "records on devnet, payments
# on mainnet", rehearsed without mainnet money: records on a throwaway local validator, the mock
# catalog seller paid in devnet USDC (x402.org facilitator) from .keys/buyer.json.
#   round 1  127.0.0.1/api/paid   → paid on devnet, receipt verified, fulfilled (recorded on localnet)
#   round 2  localhost/api/flaky  → paid, first delivery fails, same payment header again → recovered
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export NODE_USE_ENV_PROXY=1 NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
RUN_DIR=run/cross-network; mkdir -p "$RUN_DIR"
for p in 8787 8810 8899; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && { echo "port $p in use"; exit 1; }; done
PROGRAM_ID=$(solana-keygen pubkey target/deploy/rfq_market-keypair.json)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# mock seller: devnet
CS=$(solana-keygen pubkey .keys/catalog_seller.json)
if [ "$(solana -ud balance "$CS" --lamports | cut -d' ' -f1)" -lt 5000000 ]; then
  solana -ud transfer -k .keys/deployer.json --allow-unfunded-recipient "$CS" 0.01 >/dev/null
fi
CLUSTER=devnet RPC_URL=https://api.devnet.solana.com X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 \
  USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU FACILITATOR_URL=https://x402.org/facilitator \
  node --import tsx scripts/mock-catalog-seller.ts > "$RUN_DIR/mock-catalog.log" 2>&1 & PIDS+=($!)

# records: local validator with its own network id
export CLUSTER=localnet RPC_URL=http://127.0.0.1:8899 X402_NETWORK=solana:localnet LOG_DIR=log/localnet
solana-test-validator --reset --quiet --ledger "$RUN_DIR/ledger" --bpf-program "$PROGRAM_ID" target/deploy/rfq_market.so > "$RUN_DIR/validator.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
export USDC_MINT=$(npx tsx scripts/localnet-setup.ts)
npx tsx scripts/init-config.ts >/dev/null
export INDEXER_PORT=8787 INDEXER_URL=http://127.0.0.1:8787 INDEXER_PUBLIC_URL=http://127.0.0.1:8787 INDEXER_DATA_DIR=$RUN_DIR/indexer
node --import tsx indexer/src/server.ts > "$RUN_DIR/indexer.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "$INDEXER_URL/health" >/dev/null && curl -s -o /dev/null http://127.0.0.1:8810/api/free && break; sleep 1; done

export BUYER_KEYPAIR=.keys/buyer.json DEVNET_PAY_KEYPAIR=.keys/buyer.json CATALOG_PAY_HOSTS=127.0.0.1,localhost
rc=0
for spec in test/cross-paid.json test/cross-flaky.json; do
  name=$(basename "$spec" .json); t0=$(date +%s)
  set +e
  BUYER_SCENARIO=$name BUYER_SPEC_FILE=$spec BUYER_MAX_PRICE=10000 BUYER_RFQ_WINDOW_SEC=8 npx tsx agents/buyer/src/index.ts 2>&1 | tee "$RUN_DIR/buyer-$name.log"
  r=${PIPESTATUS[0]}
  set -e
  echo "==== $name exit=$r wall=$(( $(date +%s) - t0 ))s ===="
  [ "$r" = 0 ] || rc=1
done
echo "---- /fulfillments ----"; curl -s "$INDEXER_URL/fulfillments"; echo
echo "---- /quotes ----"; curl -s "$INDEXER_URL/quotes"; echo
echo "---- /sellers ----"; curl -s "$INDEXER_URL/sellers"; echo
exit $rc
