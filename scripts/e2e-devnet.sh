#!/usr/bin/env bash
# One-shot devnet E2E: 2 sellers up → buyer posts 1 RFQ → 2 quotes → award (fee)
# → x402 payment via the public facilitator → record_fulfillment → GET /fulfillments.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
[ -f .env ] && set -a && . ./.env && set +a
export CLUSTER=devnet RPC_URL=${RPC_URL:-https://api.devnet.solana.com}
export X402_NETWORK=${X402_NETWORK:-solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1}
export FACILITATOR_URL=${FACILITATOR_URL:-https://x402.org/facilitator}
export LOG_DIR=log RUN_DIR=run/devnet
case "$RPC_URL" in *mainnet*) echo "refusing: mainnet RPC"; exit 1;; esac

# Refresh the seller catalog snapshot from the public endpoint repo (read-only clone)
# so it satisfies the buyer's freshness_hours. Skipped if the clone fails.
SNAP_SRC=${ENDPOINT_REPO_DIR:-run/endpoint-ro}
if [ "${SKIP_SNAPSHOT_REFRESH:-0}" != 1 ]; then
  if [ -d "$SNAP_SRC/.git" ]; then git -C "$SNAP_SRC" pull -q --ff-only || true
  else git clone -q --depth 1 https://github.com/kato9292929/endpoint.git "$SNAP_SRC" || true; fi
  [ -d "$SNAP_SRC/data" ] && node scripts/build-catalog-snapshot.mjs "$SNAP_SRC"
fi

echo "facilitator: $FACILITATOR_URL"
curl -sf "$FACILITATOR_URL/supported" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).kinds.filter(k=>k.network===process.env.X402_NETWORK||k.network==="solana-devnet");console.log("facilitator kinds for devnet:",JSON.stringify(k))})'

BUYER=$(solana-keygen pubkey .keys/buyer.json)
echo "buyer $BUYER SOL=$(solana -u "$RPC_URL" balance "$BUYER")"
spl-token -u "$RPC_URL" balance --owner "$BUYER" 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU 2>/dev/null | sed 's/^/buyer USDC=/' || echo "buyer has no devnet USDC account"

bash scripts/e2e-run.sh
