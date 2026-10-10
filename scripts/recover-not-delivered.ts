// Record an x402 payment that landed without delivery as record_rejection(not_delivered)
// for an RFQ stuck in Awarded:  npx tsx scripts/recover-not-delivered.ts <rfq> <payment_tx> [note]
// Checks before writing anything on-chain:
//  - RFQ is Awarded and the buyer key is its buyer
//  - payment tx succeeded, after the award, and contains a TransferChecked of exactly
//    quote.price of the configured mint, authority = buyer, destination owned by the seller
//  - the buyer signed it (its signature is extracted and logged)
//  - no fulfillment/rejection already cites this payment tx
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { REASONS, appendLog, connection, env, explorerTx, loadKeypair, pdas, program, sha256 } from "../lib/common.js";

const [rfqArg, paymentTx, note = ""] = process.argv.slice(2);
const kp = loadKeypair(env("BUYER_KEYPAIR", ".keys/buyer.json"));
const prog = program(kp);
const conn = connection();
const P = pdas(prog.programId);
const rfq = new PublicKey(rfqArg);
const fail = (m: string) => { console.error(`refusing: ${m}`); process.exit(1); };

const r = await prog.account.rfq.fetch(rfq);
if (!r.buyer.equals(kp.publicKey)) fail("buyer key is not the RFQ buyer");
if (r.status !== 1 || !r.awardedQuote) fail(`RFQ status is ${r.status}, expected 1 (awarded)`);
const quotePk = r.awardedQuote!;
const quote = await prog.account.quote.fetch(quotePk);
const cfg = await prog.account.config.fetch(P.config());

const tx = await conn.getParsedTransaction(paymentTx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
if (!tx) fail("payment tx not found");
if (tx!.meta?.err) fail(`payment tx failed: ${JSON.stringify(tx!.meta.err)}`);
const keys = tx!.transaction.message.accountKeys;
const buyerIdx = keys.findIndex((k) => k.pubkey.equals(kp.publicKey) && k.signer);
if (buyerIdx < 0) fail("buyer did not sign the payment tx");
const buyerSignature = tx!.transaction.signatures[buyerIdx];

const transfer = tx!.transaction.message.instructions.find(
  (i: any) => i.parsed?.type === "transferChecked" && i.parsed.info.mint === cfg.usdcMint.toBase58(),
) as any;
if (!transfer) fail("no TransferChecked of the configured mint");
const info = transfer.parsed.info;
if (info.authority !== kp.publicKey.toBase58()) fail("transfer authority is not the buyer");
if (info.tokenAmount.amount !== quote.price.toString()) fail(`amount ${info.tokenAmount.amount} != quote.price ${quote.price}`);
const destOwner = tx!.meta!.postTokenBalances!.find((b) => keys[b.accountIndex].pubkey.toBase58() === info.destination)?.owner;
if (destOwner !== quote.seller.toBase58()) fail(`destination owner ${destOwner} is not the awarded seller`);

const [fs, rs] = await Promise.all([prog.account.fulfillment.all(), prog.account.rejection.all()]);
if ([...fs, ...rs].some((x) => bs58.encode(Buffer.from(x.account.paymentSig)) === paymentTx)) fail("payment tx already cited by a record");

const respHash = sha256(""); // nothing was delivered
const sig = await prog.methods
  .recordRejection([...bs58.decode(paymentTx)], [...respHash], REASONS.not_delivered.code)
  .accountsPartial({ buyer: kp.publicKey, rfq, quote: quotePk })
  .rpc();
appendLog({
  actor: "buyer", step: "record_rejection", rfq: rfq.toBase58(), rejection: P.rejection(rfq).toBase58(),
  seller: quote.seller.toBase58(), payment_tx: paymentTx, reason: "not_delivered", reason_code: REASONS.not_delivered.code,
  response_sha256: respHash.toString("hex"),
  detail: {
    matched_by: "post-hoc: buyer signed the tx; TransferChecked of quote.price, configured mint, authority=buyer, destination owned by awarded seller; not cited by any other record",
    buyer_signature: buyerSignature, payment_slot: tx!.slot, note,
  },
  tx: sig, explorer: explorerTx(sig),
});
console.log(JSON.stringify({ record_rejection_tx: sig, buyer_signature: buyerSignature }));
