// Record a catalog payment that landed without delivery as record_rejection(not_delivered), for an
// RFQ left Awarded because the buyer stopped before recording (e.g. an RPC failure while it looked
// for the payment). Works for any payment network the catalog quote names (Solana or Base).
//   npx tsx scripts/record-catalog-not-delivered.ts <rfq> <payment_tx> <http_status>
// Checks first: RFQ is Awarded to a catalog quote, this key is its buyer, the payment moved exactly
// quote.price from the payer the RFQ spec committed to the 402's payTo, and no record cites it yet.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { REASONS, ROOT, appendLog, env, explorerTx, loadKeypair, pdas, program, sha256 } from "../lib/common.js";
import { BASE_USDC, USDC_BY_NETWORK, baseRpcUrl, checkUsdcTransfer, encodePaymentRef, explorerFor, isEvm, memoInstruction, verifyConnection } from "../lib/payment-net.js";
import { checkEvmTransfer } from "../lib/evm-pay.js";
import { connection } from "../lib/common.js";

const [rfqArg, paymentTx, status = "0"] = process.argv.slice(2);
const kp = loadKeypair(env("BUYER_KEYPAIR", ".keys/buyer.json"));
const prog = program(kp);
const P = pdas(prog.programId);
const fail = (m: string) => { console.error(`refusing: ${m}`); process.exit(1); };

const rfq = new PublicKey(rfqArg);
const r = await prog.account.rfq.fetch(rfq);
if (!r.buyer.equals(kp.publicKey)) fail("buyer key is not the RFQ buyer");
if (r.status !== 1 || !r.awardedQuote) fail(`RFQ status is ${r.status}, expected 1 (awarded)`);
const quote = await prog.account.quote.fetch(r.awardedQuote!);
const cat = await prog.account.catalogQuote.fetchNullable(P.catalogQuote(r.awardedQuote!));
if (!cat) fail("awarded quote is not a catalog quote");
const network = cat!.network;
// the spec by its on-chain hash: the indexer's local store, else its spec_uri
const h = Buffer.from(r.specHash).toString("hex");
const local = resolve(ROOT, process.env.INDEXER_DATA_DIR ?? "indexer/.data", "specs", `${h}.json`);
const bytes = existsSync(local) ? readFileSync(local) : Buffer.from(await (await fetch(r.specUri)).arrayBuffer());
if (sha256(bytes).toString("hex") !== h) fail("spec bytes do not match the RFQ's spec_hash");
const spec = JSON.parse(bytes.toString("utf8"));
const payer = spec?.payers?.[network];
if (typeof payer !== "string") fail(`spec does not commit a payer for ${network}`);
const amount = BigInt(quote.price.toString());
const check = isEvm(network)
  ? await checkEvmTransfer(baseRpcUrl(), paymentTx, { usdc: BASE_USDC, buyer: payer, seller: cat!.payTo, amount, network })
  : await checkUsdcTransfer(verifyConnection(network, connection())!, paymentTx, { mint: USDC_BY_NETWORK[network], buyer: payer, seller: cat!.payTo, amount, network });
if (!check.ok) fail(`payment does not match: ${check.reason} ${JSON.stringify(check.details)}`);

const respHash = sha256(Buffer.from(""));
const sig = await prog.methods
  .recordRejection(encodePaymentRef(network, paymentTx), [...respHash], REASONS.not_delivered.code)
  .accountsPartial({ buyer: kp.publicKey, rfq, quote: r.awardedQuote! })
  .postInstructions([memoInstruction({ pay_net: network, payer, retry: "not_allowed", first_status: Number(status) })])
  .rpc();
console.log(`record_rejection(not_delivered) tx=${sig}`);
appendLog({
  actor: "operator", step: "record_rejection", scenario: process.env.BUYER_SCENARIO ?? "manual", rfq: rfq.toBase58(), host: cat!.host,
  payment_tx: paymentTx, payment_network: network, payment_explorer: explorerFor(network, paymentTx), reason: "not_delivered",
  reason_code: REASONS.not_delivered.code, detail: { http_status: Number(status), check: check.reason, recorded_after_buyer_stopped: true },
  tx: sig, explorer: explorerTx(sig),
});
