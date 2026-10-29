// Where payments happen vs where they are recorded. The RFQ program (records) runs on one
// cluster; a catalog seller is paid on whatever network its own 402 names. Today: records on
// devnet, real catalog sellers paid in mainnet USDC from a separate mainnet buyer key.
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { DEVNET_USDC_MINT, RPC_URL, SOLANA_DEVNET_CAIP2, X402_NETWORK, loadKeypair } from "./common.js";

export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BASE_MAINNET_CAIP2 = "eip155:8453";

/** USDC per network: Solana ones can be paid by this buyer, others are only recognised. */
export const USDC_BY_NETWORK: Record<string, string> = {
  [SOLANA_DEVNET_CAIP2]: DEVNET_USDC_MINT,
  [SOLANA_MAINNET_CAIP2]: MAINNET_USDC_MINT,
  [BASE_MAINNET_CAIP2]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export const BASE_USDC = USDC_BY_NETWORK[BASE_MAINNET_CAIP2];
/** EIP-712 domain of Circle USDC on Base, used only when a 402 omits it for that exact asset. */
export const BASE_USDC_EIP712 = { name: "USD Coin", version: "2" };

/**
 * Fill a missing EIP-712 name/version on Base accepts, only for Circle USDC on Base. Mutates
 * `accepts`; returns what was filled. Accepts for other assets are left as they are (not paid).
 */
export function fillBaseEip712(accepts: { network: string; asset: string; extra?: Record<string, any> }[]): { asset: string; extra: Record<string, any> }[] {
  const filled = [];
  for (const a of accepts) {
    if (a.network !== BASE_MAINNET_CAIP2 || (a.extra?.name && a.extra?.version)) continue;
    if (String(a.asset).toLowerCase() !== BASE_USDC.toLowerCase()) continue;
    a.extra = { ...(a.extra ?? {}), name: a.extra?.name || BASE_USDC_EIP712.name, version: a.extra?.version || BASE_USDC_EIP712.version };
    filled.push({ asset: a.asset, extra: a.extra });
  }
  return filled;
}

export type SvmPayer = { kind: "svm"; network: string; address: string; keypair: Keypair; rpcUrl: string; conn: Connection; usdcMint: PublicKey };
export type EvmPayer = { kind: "evm"; network: string; address: string; privateKey: `0x${string}`; rpcUrl: string; usdc: `0x${string}` };
export type Payer = SvmPayer | EvmPayer;

const svmPayer = (network: string, keypair: Keypair, rpcUrl: string, mint: PublicKey): SvmPayer => ({
  kind: "svm", network, address: keypair.publicKey.toBase58(), keypair, rpcUrl, conn: new Connection(rpcUrl, "confirmed"), usdcMint: mint,
});

/**
 * Payers by network. The record cluster's own network is paid by the record buyer key.
 * Mainnet networks are added only with CONFIRM_MAINNET=yes:
 *   Solana mainnet — MAINNET_RPC_URL + MAINNET_BUYER_KEYPAIR
 *   Base mainnet   — MAINNET_BUYER_BASE_KEY (BASE_RPC_URL, default the public https://mainnet.base.org)
 */
export async function loadPayers(recordKp: Keypair, recordMint: PublicKey): Promise<{ payers: Map<string, Payer>; notes: string[] }> {
  const payers = new Map<string, Payer>();
  const notes: string[] = [];
  const own = X402_NETWORK();
  payers.set(own, svmPayer(own, recordKp, RPC_URL(), recordMint));
  const { CONFIRM_MAINNET, MAINNET_RPC_URL, MAINNET_BUYER_KEYPAIR, MAINNET_BUYER_BASE_KEY } = process.env;
  if (own !== SOLANA_MAINNET_CAIP2) {
    if (!MAINNET_BUYER_KEYPAIR) notes.push("Solana mainnet payments off: MAINNET_BUYER_KEYPAIR not set");
    else if (CONFIRM_MAINNET !== "yes") notes.push("Solana mainnet payments off: CONFIRM_MAINNET=yes not set");
    else if (!MAINNET_RPC_URL) notes.push("Solana mainnet payments off: MAINNET_RPC_URL not set");
    else payers.set(SOLANA_MAINNET_CAIP2, svmPayer(SOLANA_MAINNET_CAIP2, loadKeypair(MAINNET_BUYER_KEYPAIR), MAINNET_RPC_URL, new PublicKey(MAINNET_USDC_MINT)));
  }
  if (!MAINNET_BUYER_BASE_KEY) notes.push("Base payments off: MAINNET_BUYER_BASE_KEY not set");
  else if (CONFIRM_MAINNET !== "yes") notes.push("Base payments off: CONFIRM_MAINNET=yes not set");
  else {
    const { privateKeyToAccount } = await import("viem/accounts");
    const pk = (MAINNET_BUYER_BASE_KEY.trim().startsWith("0x") ? MAINNET_BUYER_BASE_KEY.trim() : `0x${MAINNET_BUYER_BASE_KEY.trim()}`) as `0x${string}`;
    payers.set(BASE_MAINNET_CAIP2, {
      kind: "evm", network: BASE_MAINNET_CAIP2, address: privateKeyToAccount(pk).address, privateKey: pk,
      rpcUrl: baseRpcUrl(), usdc: BASE_USDC as `0x${string}`,
    });
  }
  // Test only: records on a local validator, payments on devnet (scripts/test-cross-network.sh).
  if (own !== SOLANA_DEVNET_CAIP2 && process.env.DEVNET_PAY_KEYPAIR) {
    const rpc = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
    payers.set(SOLANA_DEVNET_CAIP2, svmPayer(SOLANA_DEVNET_CAIP2, loadKeypair(process.env.DEVNET_PAY_KEYPAIR), rpc, new PublicKey(DEVNET_USDC_MINT)));
  }
  return { payers, notes };
}

export const baseRpcUrl = () => process.env.BASE_RPC_URL || "https://mainnet.base.org";
export const isEvm = (network: string) => network.startsWith("eip155:");

/**
 * Payment tx id ↔ the 64-byte payment_sig field of Fulfillment/Rejection.
 * Solana: the 64-byte signature. EVM: the 32-byte tx hash, zero-padded. All zeros: no payment found.
 */
export function encodePaymentRef(network: string, tx: string | null): number[] {
  if (!tx) return Array(64).fill(0);
  if (isEvm(network)) {
    const h = Buffer.from(tx.replace(/^0x/, ""), "hex");
    if (h.length !== 32) throw new Error(`EVM tx hash must be 32 bytes, got ${h.length}`);
    return [...h, ...Array(32).fill(0)];
  }
  const b = bs58.decode(tx);
  if (b.length !== 64) throw new Error(`payment signature is ${b.length} bytes, expected 64`);
  return [...b];
}
export function decodePaymentRef(network: string, bytes: Uint8Array | number[]): string | null {
  const b = Buffer.from(bytes);
  if (b.every((x) => x === 0)) return null;
  return isEvm(network) ? `0x${b.subarray(0, 32).toString("hex")}` : bs58.encode(b);
}

export function explorerFor(network: string, tx: string): string {
  if (isEvm(network)) return `https://basescan.org/tx/${tx}`;
  if (network === SOLANA_MAINNET_CAIP2) return `https://explorer.solana.com/tx/${tx}`;
  if (network === SOLANA_DEVNET_CAIP2) return `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
  return tx;
}

/** Connection for verifying a payment on `network` (indexer side). */
export function verifyConnection(network: string, recordConn: Connection): Connection | null {
  if (network === X402_NETWORK()) return recordConn;
  if (network === SOLANA_MAINNET_CAIP2 && process.env.MAINNET_RPC_URL) return new Connection(process.env.MAINNET_RPC_URL, "confirmed");
  if (network === SOLANA_DEVNET_CAIP2) return new Connection(process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  return null;
}

// ---- record memo -------------------------------------------------------------
// record_fulfillment / record_rejection keep their account layouts; what the program has no
// field for (payment network and payer, receipt check, recovery) rides in an SPL Memo
// instruction of the same transaction, so it is on-chain and tied to that record.
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MEMO_TAG = "rfq402";

export type RecordMemo = {
  pay_net?: string; // CAIP-2 network the payment tx is on
  payer?: string; // address that paid
  receipt?: "ok" | "bad" | "none";
  receipt_signer?: string;
  recovered?: boolean; // first paid call failed, a re-request with the same payment header delivered
  retry?: "failed" | "not_allowed";
  outcome?: "delivered_without_settlement"; // 200 arrived but no payment landed
  first_status?: number; // HTTP status of the failed first paid call
};

export function memoInstruction(m: RecordMemo): TransactionInstruction {
  const data = Buffer.from(JSON.stringify({ [MEMO_TAG]: 1, ...m }), "utf8");
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data });
}

/** Parse our memo out of a memo log string ("[n] {json}" or "{json}"). */
export function parseRecordMemo(s: string): RecordMemo | null {
  const i = s.indexOf("{");
  if (i < 0) return null;
  try {
    const j = JSON.parse(s.slice(i));
    if (j?.[MEMO_TAG] !== 1) return null;
    delete j[MEMO_TAG];
    return j;
  } catch {
    return null;
  }
}

// ---- payment check -----------------------------------------------------------

export type TransferCheck = { ok: boolean; reason: string; details: Record<string, unknown> };

/** Did tx `sig` move exactly `amount` of `mint` from `buyer` to `seller` (by owner)? */
export async function checkUsdcTransfer(
  c: Connection, sig: string, f: { mint: string; buyer: string; seller: string; amount: bigint; network: string },
): Promise<TransferCheck> {
  const tx = await c.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return { ok: false, reason: "transaction not found", details: { network: f.network } };
  if (tx.meta?.err) return { ok: false, reason: `transaction failed: ${JSON.stringify(tx.meta.err)}`, details: { network: f.network } };
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const delta = (owner: string) => {
    const amt = (arr: typeof pre) => arr.filter((b) => b.mint === f.mint && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    return amt(post) - amt(pre);
  };
  const sellerDelta = delta(f.seller);
  const buyerDelta = delta(f.buyer);
  const details = {
    network: f.network, mint: f.mint, seller: f.seller, buyer: f.buyer, expected_amount: f.amount.toString(),
    seller_received: sellerDelta.toString(), buyer_sent: (-buyerDelta).toString(), slot: tx.slot, block_time: tx.blockTime,
  };
  if (sellerDelta !== f.amount) return { ok: false, reason: "seller USDC delta does not equal quote.price", details };
  if (-buyerDelta !== f.amount) return { ok: false, reason: "buyer USDC delta does not equal quote.price", details };
  return { ok: true, reason: `USDC transfer buyer→seller of quote.price confirmed on ${f.network}`, details };
}
