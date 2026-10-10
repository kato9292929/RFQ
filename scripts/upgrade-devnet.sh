#!/usr/bin/env bash
# Upgrade the deployed rfq_market in place (same program id), extending programdata
# first if the new binary is larger. Appends to log/deploy.md. Devnet only
# (RPC_URL may point at a local validator for a rehearsal).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
RPC_URL=${RPC_URL:-https://api.devnet.solana.com}
case "$RPC_URL" in *mainnet*) echo "refusing: mainnet RPC"; exit 1;; esac
DEPLOYER=${DEPLOYER_KEYPAIR:-.keys/deployer.json}
PROGRAM_KP=target/deploy/rfq_market-keypair.json
SO=target/deploy/rfq_market.so
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KP")
DEPLOY_LOG=${DEPLOY_LOG:-log/deploy.md}

cur=$(solana program show -u "$RPC_URL" "$PROGRAM_ID" --output json | node -pe 'JSON.parse(require("fs").readFileSync(0)).dataLen')
new=$(stat -c %s "$SO")
echo "program $PROGRAM_ID programdata=$cur bytes, new binary=$new bytes, deployer balance $(solana -u "$RPC_URL" balance -k "$DEPLOYER")"
EXTEND_SIG=""
if [ "$new" -gt "$cur" ]; then
  add=$((new - cur + 1024))
  echo "extending programdata by $add bytes"
  EXTEND_OUT=$(solana program extend -u "$RPC_URL" -k "$DEPLOYER" "$PROGRAM_ID" "$add" 2>&1) || { echo "$EXTEND_OUT"; exit 1; }
  echo "$EXTEND_OUT"
  EXTEND_SIG=$(echo "$EXTEND_OUT" | sed -n 's/^Signature: //p' | tail -1)
  [ -n "$EXTEND_SIG" ] || EXTEND_SIG=$(echo "$EXTEND_OUT" | tail -1)
fi
OUT=$(solana program deploy -u "$RPC_URL" -k "$DEPLOYER" --program-id "$PROGRAM_KP" "$SO" \
  --max-sign-attempts 50 --use-rpc 2>&1) || { echo "$OUT"; exit 1; }
echo "$OUT"
SIG=$(echo "$OUT" | sed -n 's/^Signature: //p' | tail -1)
{
  echo ""
  echo "## Upgrade $(date -u +%Y-%m-%dT%H:%M:%SZ) ($([ "$RPC_URL" = https://api.devnet.solana.com ] && echo devnet || echo "$RPC_URL"))"
  echo ""
  echo "Same program id \`$PROGRAM_ID\`; existing Config/Rfq/Quote/Fulfillment layouts unchanged."
  echo "Adds \`record_rejection\` (Rejection PDA [\"rejection\", rfq], rfq status 5 = Rejected), \`declare_sla\` / \`record_latency\` (Sla PDA [\"sla\", quote])."
  echo ""
  echo "| item | value |"
  echo "|---|---|"
  echo "| programdata before / binary after | $cur / $new bytes |"
  echo "| extend tx | \`${EXTEND_SIG:-not needed}\` |"
  echo "| upgrade tx | \`${SIG:-n/a}\` |"
  echo "| git commit | \`$(git rev-parse --short HEAD)\` |"
} >> "$DEPLOY_LOG"
echo "appended to $DEPLOY_LOG"
