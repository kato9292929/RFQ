#!/usr/bin/env bash
# Full E2E against a throwaway local validator, with the in-repo facilitator.
# Use this to exercise everything without devnet SOL/USDC. Not a substitute for e2e-devnet.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export CLUSTER=localnet RPC_URL=http://127.0.0.1:8899 LOG_DIR=${LOG_DIR:-log/localnet}
export FACILITATOR_URL=http://127.0.0.1:8790 FACILITATOR_KEYPAIR=.keys/facilitator.json
export X402_NETWORK=${X402_NETWORK:-solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1}
export RUN_DIR=run/localnet
mkdir -p .keys "$RUN_DIR"
for k in deployer buyer seller1 seller2 treasury_owner facilitator; do
  [ -f .keys/$k.json ] || solana-keygen new --no-bip39-passphrase -s -o .keys/$k.json >/dev/null
done
PROGRAM_ID=$(solana-keygen pubkey target/deploy/rfq_market-keypair.json)

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

solana-test-validator --reset --quiet --ledger "$RUN_DIR/ledger" \
  --bpf-program "$PROGRAM_ID" target/deploy/rfq_market.so > "$RUN_DIR/validator.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done

export USDC_MINT=$(npx tsx scripts/localnet-setup.ts)
echo "local test USDC mint: $USDC_MINT"
npx tsx scripts/init-config.ts
npx tsx facilitator/src/server.ts > "$RUN_DIR/facilitator.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 30); do curl -sf $FACILITATOR_URL/supported >/dev/null && break; sleep 1; done

bash scripts/e2e-run.sh
