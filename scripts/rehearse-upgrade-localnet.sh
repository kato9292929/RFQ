#!/usr/bin/env bash
# Rehearse the devnet upgrade on a local validator: load the binary currently on devnet
# (dumped to run/rehearsal/deployed-old.so) as an upgradeable program owned by the
# deployer key, create state with the old instructions, run scripts/upgrade-devnet.sh
# against the local RPC, then check old accounts still read and new instructions work.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export CLUSTER=localnet RPC_URL=http://127.0.0.1:8899 LOG_DIR=log/localnet RUN_DIR=run/rehearsal
export FACILITATOR_URL=http://127.0.0.1:8790 FACILITATOR_KEYPAIR=.keys/facilitator.json
PROGRAM_ID=$(solana-keygen pubkey target/deploy/rfq_market-keypair.json)
OLD=run/rehearsal/deployed-old.so
[ -f "$OLD" ] || solana program dump -ud "$PROGRAM_ID" "$OLD"

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
solana-test-validator --reset --quiet --ledger "$RUN_DIR/ledger" \
  --upgradeable-program "$PROGRAM_ID" "$OLD" "$(solana-keygen pubkey .keys/deployer.json)" > "$RUN_DIR/validator.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done

export USDC_MINT=$(npx tsx scripts/localnet-setup.ts)
npx tsx scripts/init-config.ts >/dev/null
echo "pre-upgrade state: $(npx tsx scripts/rehearsal-seed.ts 2>/dev/null | tail -1)"

DEPLOY_LOG=run/rehearsal/deploy.md bash scripts/upgrade-devnet.sh

export NODE_USE_ENV_PROXY=1
node --import tsx facilitator/src/server.ts > "$RUN_DIR/facilitator.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 30); do curl -sf $FACILITATOR_URL/supported >/dev/null && break; sleep 1; done
SCENARIOS=${SCENARIOS:-"schema-reject:100000 sla-tight:100000"} bash scripts/e2e-run.sh
