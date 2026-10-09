// Shared helpers for the indexer, agents and scripts.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { RfqMarket } from "../idl/rfq_market.js";

const { AnchorProvider, Program, Wallet } = anchor;
export type RfqProgram = anchor.Program<RfqMarket>;

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// x402 v2 uses CAIP-2 network ids. This is the CAIP-2 id of `solana-devnet`.
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const STATUS = ["open", "awarded", "fulfilled", "cancelled", "expired"] as const;

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
