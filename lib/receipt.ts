// Delivery Receipt: a seller's signed statement "for payment <id> I delivered a body with this
// sha256", sent as a response header on the paid 200. The payment id is the Solana tx signature.
// A seller that issues receipts also answers a second request carrying the SAME payment header
// with the same body, without charging again — that is how a buyer recovers a paid response
// that did not arrive (not_delivered).
//
// Header: Delivery-Receipt (X-Delivery-Receipt is accepted too) = base64(JSON of DeliveryReceipt).
// Signature: ed25519 by `signer` over the UTF-8 bytes of receiptMessage(r).
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import bs58 from "bs58";
import type { Keypair } from "@solana/web3.js";
import { sha256 } from "./common.js";

export const RECEIPT_HEADER = "Delivery-Receipt";
const HEADER_NAMES = [RECEIPT_HEADER, "X-Delivery-Receipt"];

export type DeliveryReceipt = {
  v: 1;
  payment_id: string; // Solana tx signature of the settled payment
  network: string; // CAIP-2
  resource: string; // URL that was paid for
  body_sha256: string; // hex sha256 of the 200 body bytes
  signer: string; // base58 ed25519 public key
  issued_at: string; // ISO time
  sig: string; // base58 ed25519 signature
};

export function receiptMessage(r: Omit<DeliveryReceipt, "sig">): string {
  return ["x402-delivery-receipt", `v${r.v}`, r.network, r.payment_id, r.resource, r.body_sha256, r.signer, r.issued_at].join("\n");
}

// Raw 32-byte ed25519 keys wrapped in the fixed DER prefixes node:crypto expects.
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export function makeReceipt(kp: Keypair, f: { payment_id: string; network: string; resource: string; body: Uint8Array }): DeliveryReceipt {
  const base = {
    v: 1 as const, payment_id: f.payment_id, network: f.network, resource: f.resource,
    body_sha256: sha256(f.body).toString("hex"), signer: kp.publicKey.toBase58(), issued_at: new Date().toISOString(),
  };
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(kp.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" });
  return { ...base, sig: bs58.encode(sign(null, Buffer.from(receiptMessage(base), "utf8"), key)) };
}

export const encodeReceipt = (r: DeliveryReceipt) => Buffer.from(JSON.stringify(r), "utf8").toString("base64");

export function readReceipt(get: (name: string) => string | null): DeliveryReceipt | null {
  for (const n of HEADER_NAMES) {
    const v = get(n);
    if (!v) continue;
    try {
      return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

export type ReceiptCheck = {
  present: boolean;
  ok: boolean;
  signer?: string;
  signer_is_pay_to?: boolean;
  problems: string[];
};

/** Body hash, signature, and that it names the payment we made. */
export function checkReceipt(r: DeliveryReceipt | null, f: { body: Uint8Array; payment_id: string; network: string; pay_to: string }): ReceiptCheck {
  if (!r) return { present: false, ok: false, problems: ["no receipt header"] };
  const problems: string[] = [];
  if (r.v !== 1) problems.push(`unknown version ${r.v}`);
  if (r.body_sha256 !== sha256(f.body).toString("hex")) problems.push("body_sha256 does not match the body");
  if (r.payment_id !== f.payment_id) problems.push("payment_id is not our payment tx");
  if (r.network !== f.network) problems.push(`network ${r.network} != ${f.network}`);
  let sigOk = false;
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(bs58.decode(r.signer))]), format: "der", type: "spki" });
    const { sig, ...base } = r;
    sigOk = verify(null, Buffer.from(receiptMessage(base), "utf8"), pub, Buffer.from(bs58.decode(sig)));
  } catch (e: any) {
    problems.push(`signature check error: ${e?.message ?? e}`);
  }
  if (!sigOk) problems.push("signature does not verify");
  return { present: true, ok: problems.length === 0, signer: r.signer, signer_is_pay_to: r.signer === f.pay_to, problems };
}
