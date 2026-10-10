#!/usr/bin/env bash
# Deploy rfq_market to Solana devnet, create Config, fund agent keys with SOL,
# and append the result to log/deploy.md. Devnet only.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
export NODE_USE_ENV_PROXY=1
export CLUSTER=devnet RPC_URL=${RPC_URL:-https://api.devnet.solana.com}
export USDC_MINT=${USDC_MINT:-4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU}
case "$RPC_URL" in *mainnet*) echo "refusing: mainnet RPC"; exit 1;; esac

DEPLOYER=.keys/deployer.json
PROGRAM_KP=target/deploy/rfq_market-keypair.json
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KP")
echo "deployer $(solana-keygen pubkey $DEPLOYER) balance: $(solana -u "$RPC_URL" balance -k $DEPLOYER)"

DEPLOY_OUT=$(solana program deploy -u "$RPC_URL" -k "$DEPLOYER" --program-id "$PROGRAM_KP" \
  target/deploy/rfq_market.so --max-sign-attempts 50 --use-rpc 2>&1) || { echo "$DEPLOY_OUT"; exit 1; }
echo "$DEPLOY_OUT"
DEPLOY_SIG=$(echo "$DEPLOY_OUT" | sed -n 's/^Signature: //p' | tail -1)

# Small SOL float for the agents (rent for quotes/fulfillment/ATAs + tx fees).
for k in buyer seller1 seller2; do
  solana transfer -u "$RPC_URL" -k "$DEPLOYER" --allow-unfunded-recipient "$(solana-keygen pubkey .keys/$k.json)" "${AGENT_SOL:-0.05}" >/dev/null
done

INIT=$(npx tsx scripts/init-config.ts 2>/dev/null | tail -1)
echo "$INIT"
CONFIG=$(echo "$INIT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).config')
TREASURY=$(echo "$INIT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).treasury')
INIT_TX=$(echo "$INIT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).tx ?? "(already initialized)"')

{
  echo ""
  echo "## Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ) (devnet)"
  echo ""
  echo "| item | value |"
  echo "|---|---|"
  echo "| program id | \`$PROGRAM_ID\` |"
  echo "| deploy tx | \`${DEPLOY_SIG:-n/a}\` |"
  echo "| upgrade authority / config authority | \`$(solana-keygen pubkey $DEPLOYER)\` |"
  echo "| config PDA | \`$CONFIG\` |"
  echo "| initialize tx | \`$INIT_TX\` |"
  echo "| treasury (USDC ATA) | \`$TREASURY\` (owner \`$(solana-keygen pubkey .keys/treasury_owner.json)\`) |"
  echo "| fee_bps | ${FEE_BPS:-100} |"
  echo "| usdc_mint | \`$USDC_MINT\` (Circle devnet USDC) |"
  echo "| buyer | \`$(solana-keygen pubkey .keys/buyer.json)\` |"
  echo "| seller1 | \`$(solana-keygen pubkey .keys/seller1.json)\` |"
  echo "| seller2 | \`$(solana-keygen pubkey .keys/seller2.json)\` |"
  echo "| x402 facilitator | ${FACILITATOR_URL:-https://x402.org/facilitator} (network \`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1\` = solana-devnet) |"
} >> log/deploy.md
echo "appended to log/deploy.md"
