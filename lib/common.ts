// Shared helpers for the indexer, agents and scripts.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { RfqMarket } from "../idl/rfq_market.js";

const { AnchorProvider, Program, Wallet } = anchor;
export type RfqProgram = anchor.Program<RfqMarket>;

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// x402 v2 uses CAIP-2 network ids. This is the CAIP-2 id of `solana-devnet`.
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const STATUS = ["open", "awarded", "fulfilled", "cancelled", "expired", "rejected"] as const;

/**
 * One vocabulary for "why no trade / why not accepted":
 *  - sellers use it (off-chain, logged) when declining to quote,
 *  - buyers use the on-chain codes when rejecting a paid delivery.
 * Sellers check category/field names/freshness before quoting; they do NOT check
 * JSON-Schema constraints (e.g. minItems) — those are the buyer's acceptance test.
 */
export const REASONS = {
  category_unsupported: { code: 0, onchain: false },
  missing_fields: { code: 1, onchain: true },
  stale_data: { code: 2, onchain: true },
  schema_mismatch: { code: 3, onchain: true },
  invalid_response: { code: 4, onchain: true },
  not_delivered: { code: 5, onchain: true },
} as const;
export type Reason = keyof typeof REASONS;
export const reasonByCode = (c: number): Reason | "unknown" =>
  (Object.entries(REASONS).find(([, v]) => v.code === c)?.[0] as Reason) ?? "unknown";

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

export const RPC_URL = () => env("RPC_URL", "https://api.devnet.solana.com");
export const CLUSTER = () => env("CLUSTER", "devnet");
export const INDEXER_URL = () => env("INDEXER_URL", "http://127.0.0.1:8787");
export const X402_NETWORK = () => env("X402_NETWORK", SOLANA_DEVNET_CAIP2);
export const FACILITATOR_URL = () => env("FACILITATOR_URL", "https://x402.org/facilitator");

export function loadKeypair(path: string): Keypair {
  const p = resolve(ROOT, path);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

export function connection(): Connection {
  return new Connection(RPC_URL(), "confirmed");
}

export function loadIdl(): RfqMarket & { address: string } {
  const idl = JSON.parse(readFileSync(resolve(ROOT, "idl/rfq_market.json"), "utf8"));
  if (process.env.PROGRAM_ID) idl.address = process.env.PROGRAM_ID;
  return idl;
}

export function program(kp?: Keypair): RfqProgram {
  const wallet = new Wallet(kp ?? Keypair.generate());
  const provider = new AnchorProvider(connection(), wallet, { commitment: "confirmed" });
  return new Program<RfqMarket>(loadIdl(), provider);
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function pdas(programId: PublicKey) {
  const find = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    config: () => find([Buffer.from("config")]),
    rfq: (buyer: PublicKey, nonce: bigint | number) => find([Buffer.from("rfq"), buyer.toBuffer(), u64le(nonce)]),
    quote: (rfq: PublicKey, seller: PublicKey) => find([Buffer.from("quote"), rfq.toBuffer(), seller.toBuffer()]),
    fulfillment: (rfq: PublicKey) => find([Buffer.from("fulfillment"), rfq.toBuffer()]),
    rejection: (rfq: PublicKey) => find([Buffer.from("rejection"), rfq.toBuffer()]),
    sla: (quote: PublicKey) => find([Buffer.from("sla"), quote.toBuffer()]),
  };
}

export function explorerTx(sig: string): string {
  const c = CLUSTER();
  return c === "devnet" ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : `localnet:${sig}`;
}

/** Append-only run log: log/YYYY-MM-DD.jsonl (never rewritten). */
export function appendLog(record: Record<string, unknown>): void {
  const now = new Date();
  const file = resolve(ROOT, process.env.LOG_DIR ?? "log", `${now.toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify({ ts: now.toISOString(), cluster: CLUSTER(), ...record }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  appendFileSync(file, line + "\n");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** USDC base units (6 decimals) → "0.050000" */
export function fmtUsdc(n: bigint | number | string): string {
  const v = BigInt(n);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Retry transient RPC/network failures with exponential backoff. */
export async function retry<T>(fn: () => Promise<T>, label = "rpc", attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const cause = e?.cause?.code ?? e?.cause?.message ?? "";
      console.warn(`[retry] ${label} attempt ${i + 1}/${attempts} failed: ${e?.message ?? e} ${cause}`);
      await sleep(500 * 2 ** i);
    }
  }
  throw last;
}

/**
 * The buyer's own signature inside the x402 exact-SVM payment transaction.
 * The tx id is the fee payer's (facilitator's) signature, added only when the
 * facilitator submits, so the buyer cannot know it in advance; its own signature
 * is fixed once it signs and identifies the transfer uniquely.
 */
export function buyerSignatureFromPayload(payload: any, buyer: PublicKey): string {
  const b64 = payload?.payload?.transaction;
  if (typeof b64 !== "string") throw new Error("x402 payload has no payload.transaction");
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const keys = tx.message.staticAccountKeys;
  const idx = keys.findIndex((k) => k.equals(buyer));
  if (idx < 0 || idx >= tx.message.header.numRequiredSignatures) throw new Error("buyer is not a signer of the payment tx");
  const sig = tx.signatures[idx];
  if (!sig || sig.every((b) => b === 0)) throw new Error("buyer signature missing in payment tx");
  return bs58.encode(sig);
}

/**
 * After a paid request failed, look for the payment tx that contains `buyerSig`
 * among recent transactions touching the buyer's token account.
 */
export async function findLandedPayment(
  conn: Connection, buyerTokenAccount: PublicKey, buyerSig: string, timeoutMs = 90_000,
): Promise<{ signature: string; slot: number; err: unknown } | null> {
  const seen = new Set<string>();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const sigs = await retry(() => conn.getSignaturesForAddress(buyerTokenAccount, { limit: 20 }, "confirmed"), "getSignaturesForAddress");
    for (const s of sigs) {
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      const tx = await retry(
        () => conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
        "getTransaction",
      );
      if (tx?.transaction.signatures.includes(buyerSig)) return { signature: s.signature, slot: s.slot, err: tx.meta?.err ?? null };
    }
    await sleep(3000);
  }
  return null;
}
