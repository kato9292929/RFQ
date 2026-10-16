# Shared by the mainnet scripts. Keys arrive as env secrets (JSON byte arrays) and are
# written to run/mainnet/ (gitignored) with 0600 only while a script runs.
set -euo pipefail
[ "${CONFIRM_MAINNET:-}" = yes ] || { echo "refusing: set CONFIRM_MAINNET=yes to touch Solana mainnet"; exit 1; }
: "${MAINNET_RPC_URL:?set MAINNET_RPC_URL (a mainnet RPC that allows getProgramAccounts, e.g. a Helius/Triton URL)}"
export CLUSTER=mainnet RPC_URL="$MAINNET_RPC_URL"
export X402_NETWORK=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
export USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # Circle USDC on Solana mainnet
export LOG_DIR=${LOG_DIR:-log}
export NODE_USE_ENV_PROXY=1
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
KEYDIR=run/mainnet/keys
mkdir -p "$KEYDIR"; chmod 700 "$KEYDIR"
write_key() { # write_key <ENV_NAME> <file>; prints the path
  local v="${!1:-}"; [ -n "$v" ] || { echo "missing secret $1" >&2; exit 1; }
  (umask 077; printf '%s' "$v" > "$KEYDIR/$2"); echo "$KEYDIR/$2"
}
cleanup_keys() { rm -rf "$KEYDIR"; }
