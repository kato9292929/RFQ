#!/usr/bin/env bash
# Deploy rfq_market to Solana MAINNET and create its Config (USDC mainnet mint, 1% fee).
#   CONFIRM_MAINNET=yes MAINNET_RPC_URL=... MAINNET_DEPLOYER_KEYPAIR='[..64 bytes..]' \
#   [MAINNET_PROGRAM_KEYPAIR='[...]'] [MAINNET_TREASURY_OWNER=<pubkey>] bash scripts/deploy-mainnet.sh
# Needs ~2.2 SOL on the deployer (program rent ≈ 1.88 SOL + fees). Appends to log/deploy.md.
cd "$(dirname "$0")/.."
. scripts/mainnet-env.sh
trap cleanup_keys EXIT
DEPLOYER=$(write_key MAINNET_DEPLOYER_KEYPAIR deployer.json)
if [ -n "${MAINNET_PROGRAM_KEYPAIR:-}" ]; then PROGRAM_KP=$(write_key MAINNET_PROGRAM_KEYPAIR program.json); else PROGRAM_KP=target/deploy/rfq_market-keypair.json; fi
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KP")
IDL_ID=$(node -pe 'require("./idl/rfq_market.json").address')
[ "$PROGRAM_ID" = "$IDL_ID" ] || { echo "program keypair $PROGRAM_ID != IDL address $IDL_ID (set PROGRAM_ID and rebuild with that declare_id)"; exit 1; }
echo "deployer $(solana-keygen pubkey "$DEPLOYER") balance $(solana -u "$RPC_URL" balance -k "$DEPLOYER")"
# The deployer keeps the upgrade authority (no --final): the program can be replaced if a
# bug shows up. See README "Upgrade authority" for when it would be made immutable.
OUT=$(solana program deploy -u "$RPC_URL" -k "$DEPLOYER" --program-id "$PROGRAM_KP" --upgrade-authority "$DEPLOYER" \
  target/deploy/rfq_market.so --max-sign-attempts 50 --use-rpc --with-compute-unit-price 10000 2>&1) || { echo "$OUT"; exit 1; }
echo "$OUT"
SIG=$(echo "$OUT" | sed -n 's/^Signature: //p' | tail -1)
AUTHORITY=$(solana program show -u "$RPC_URL" "$PROGRAM_ID" --output json | node -pe 'JSON.parse(require("fs").readFileSync(0)).authority')
[ "$AUTHORITY" = "$(solana-keygen pubkey "$DEPLOYER")" ] || { echo "unexpected upgrade authority: $AUTHORITY"; exit 1; }
TREASURY_OWNER=${MAINNET_TREASURY_OWNER:-$(solana-keygen pubkey "$DEPLOYER")}
INIT=$(DEPLOYER_KEYPAIR="$DEPLOYER" TREASURY_OWNER_PUBKEY="$TREASURY_OWNER" FEE_BPS=${FEE_BPS:-100} npx tsx scripts/init-config.ts 2>/dev/null | tail -1)
echo "$INIT"
j() { echo "$INIT" | node -pe "JSON.parse(require('fs').readFileSync(0)).$1 ?? '(existing)'"; }
{
  echo ""
  echo "## Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ) (MAINNET)"
  echo ""
  echo "| item | value |"
  echo "|---|---|"
  echo "| program id | \`$PROGRAM_ID\` |"
  echo "| deploy tx | \`${SIG:-n/a}\` |"
  echo "| upgrade authority (kept, not immutable) | \`$AUTHORITY\` |"
  echo "| config authority | \`$(solana-keygen pubkey "$DEPLOYER")\` |"
  echo "| config PDA | \`$(j config)\` |"
  echo "| initialize tx | \`$(j tx)\` |"
  echo "| treasury (USDC ATA) | \`$(j treasury)\` (owner \`$TREASURY_OWNER\`) |"
  echo "| usdc_mint | \`$USDC_MINT\` (Circle USDC, mainnet) |"
  echo "| fee_bps | ${FEE_BPS:-100} |"
} >> log/deploy.md
echo "appended to log/deploy.md"
