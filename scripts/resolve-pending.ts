// End-of-batch check of payments the buyer could not confirm (settlement_unknown, Base): look once
// more whether each authorization landed and record the outcome on devnet, so nothing is recorded
// by hand. Never sends a payment.
//   BUYER_PENDING_FILE=run/.../pending.jsonl npx tsx scripts/resolve-pending.ts
import { existsSync, readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { REASONS, appendLog, env, explorerTx, loadKeypair, program, sha256 } from "../lib/common.js";
import { BASE_USDC, encodePaymentRef, explorerFor, memoInstruction } from "../lib/payment-net.js";
import { checkEvmTransfer, findLandedEvm } from "../lib/evm-pay.js";

const file = env("BUYER_PENDING_FILE");
const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const kp = loadKeypair(env("BUYER_KEYPAIR", ".keys/buyer.json"));
const prog = program(kp);
const log = (step: string, d: Record<string, unknown>) => appendLog({ actor: "operator", step, ...d });

for (const p of rows) {
  const ctx = { scenario: p.scenario, rfq: p.rfq, host: p.host, network: p.network };
  const r = await prog.account.rfq.fetch(new PublicKey(p.rfq));
  if (r.status !== 1) { log("settlement_resolved", { ...ctx, result: "already recorded", status: r.status }); continue; }
  const l = await findLandedEvm({ kind: "evm", network: p.network, address: p.payer, privateKey: "0x" as any, rpcUrl: "", usdc: BASE_USDC as any }, p.nonce, 30_000);
  if (l.status === "unknown" || (l.status === "landed" && !l.hash)) { log("settlement_unknown_final", { ...ctx, check: l }); console.log(`${p.host}: still unknown`); continue; }
  if (l.status === "not_landed") { log("settlement_resolved", { ...ctx, result: "not landed (nothing paid)", rpc: l.rpc }); console.log(`${p.host}: not landed`); continue; }
  const check = await checkEvmTransfer(null, l.hash, { usdc: BASE_USDC, buyer: p.payer, seller: p.pay_to, amount: BigInt(p.price), network: p.network });
  if (!check.ok) { log("settlement_unknown_final", { ...ctx, tx: l.hash, check }); console.log(`${p.host}: landed tx does not match (${check.reason})`); continue; }
  const ref = encodePaymentRef(p.network, l.hash);
  const hash = [...Buffer.from(p.response_sha256 ?? sha256(Buffer.from("")).toString("hex"), "hex")];
  const memo = memoInstruction({ pay_net: p.network, payer: p.payer, ...(p.delivered ? {} : { retry: "not_allowed" as const, first_status: p.http_status }) });
  const accts = { buyer: kp.publicKey, rfq: new PublicKey(p.rfq), quote: new PublicKey(p.quote) };
  let tx: string;
  let outcome: string;
  if (p.delivered && p.verdict?.ok) {
    tx = await prog.methods.recordFulfillment(ref, hash).accountsPartial(accts).postInstructions([memo]).rpc();
    outcome = "fulfilled";
  } else {
    const code = p.delivered ? REASONS[p.verdict.reason as keyof typeof REASONS].code : REASONS.not_delivered.code;
    tx = await prog.methods.recordRejection(ref, hash, code).accountsPartial(accts).postInstructions([memo]).rpc();
    outcome = p.delivered ? `rejected (${p.verdict.reason})` : "not_delivered";
  }
  log(p.delivered && p.verdict?.ok ? "record_fulfillment" : "record_rejection", {
    ...ctx, payment_tx: l.hash, payment_network: p.network, payment_explorer: explorerFor(p.network, l.hash), outcome,
    reason: outcome === "not_delivered" ? "not_delivered" : undefined, resolved_after: "settlement_unknown", verify_rpc: check.details.rpc, tx, explorer: explorerTx(tx),
  });
  console.log(`${p.host}: landed ${l.hash} → ${outcome} tx=${tx}`);
}
console.log(`${rows.length} pending payment(s) checked`);
