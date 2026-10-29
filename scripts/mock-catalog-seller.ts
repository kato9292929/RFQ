// Local stand-in for a catalog seller: an ordinary x402 endpoint that knows nothing about
// RFQs. Tests only (localnet / devnet). Paths:
//   /api/paid       402, 0.005 USDC   → becomes a catalog quote; 200 carries a Delivery Receipt
//   /api/flaky      402, 0.005 USDC   → settles, then fails the first delivery (503); the same
//                                       payment header sent again gets the body, no new charge
//   /api/broken     402, 0.005 USDC   → settles, never delivers (re-requests fail too) → stays not_delivered
//   /api/expensive  402, 0.02 USDC    → over the $0.01 per-call cap, skipped
//   /api/free       200               → not a 402, skipped
// A paid request whose payment header was already settled here is answered with the stored
// body and receipt, without settling again (lib/receipt.ts).
import express from "express";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { FACILITATOR_URL, RPC_URL, X402_NETWORK, connection, env, loadKeypair } from "../lib/common.js";
import { RECEIPT_HEADER, encodeReceipt, makeReceipt, type DeliveryReceipt } from "../lib/receipt.js";

const kp = loadKeypair(env("MOCK_CATALOG_KEYPAIR", ".keys/catalog_seller.json"));
const mint = new PublicKey(env("USDC_MINT"));
const PORT = Number(env("MOCK_CATALOG_PORT", "8810"));
await getOrCreateAssociatedTokenAccount(connection(), kp, mint, kp.publicKey);

const network = X402_NETWORK() as `${string}:${string}`;
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL() })).register(network, new ExactSvmScheme({ rpcUrl: RPC_URL() }));
await server.initialize();

/** The payment header's identity: the payer's own signature inside the payment tx. */
function paymentKey(payload: any): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(payload?.payload?.transaction ?? "", "base64"));
  const sigs = tx.signatures.filter((s) => !s.every((b) => b === 0));
  if (!sigs.length) throw new Error("payment tx carries no signature");
  return bs58.encode(sigs[0]);
}

type Delivered = { body: Buffer; receipt: DeliveryReceipt; settle: any };
const delivered = new Map<string, Delivered>();
const failedOnce = new Set<string>();
const log = (...a: unknown[]) => console.log("[mock-seller]", ...a);

function paid(amount: string, description: string, data: () => unknown, opts: { flaky?: boolean; broken?: boolean } = {}) {
  return async (req: express.Request, res: express.Response) => {
    const reqs = await server.buildPaymentRequirements({
      scheme: "exact", network, payTo: kp.publicKey.toBase58(), price: { asset: mint.toBase58(), amount, extra: { name: "USDC", decimals: 6 } },
    });
    const resource = { url: `http://${req.headers.host}${req.path}`, description, mimeType: "application/json" };
    const header = req.header("payment-signature") ?? req.header("x-payment");
    const required = async (error?: string) =>
      res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(await server.createPaymentRequiredResponse(reqs, resource, error))).json({});
    if (!header) return required();
    const payload = decodePaymentSignatureHeader(header);
    const key = paymentKey(payload);
    const prev = delivered.get(key);
    if (prev && opts.broken) return res.status(503).json({ error: "simulated outage" });
    if (prev) {
      // Same payment header again: hand back what was already paid for. No verify, no settle.
      log(`replay for payment ${prev.receipt.payment_id.slice(0, 12)}… (no charge)`);
      return res.status(200).set("PAYMENT-RESPONSE", encodePaymentResponseHeader(prev.settle)).set(RECEIPT_HEADER, encodeReceipt(prev.receipt))
        .set("Delivery-Replay", "1").type("application/json").send(prev.body);
    }
    const v = await server.verifyPayment(payload, reqs[0]);
    if (!v.isValid) return required(v.invalidReason ?? "invalid payment");
    const s = await server.settlePayment(payload, reqs[0]);
    if (!s.success) return required(s.errorReason ?? "settlement failed");
    const body = Buffer.from(JSON.stringify(data()));
    const receipt = makeReceipt(kp, { payment_id: s.transaction, network, resource: resource.url, body });
    delivered.set(key, { body, receipt, settle: s });
    if (opts.broken || (opts.flaky && !failedOnce.has(key))) {
      failedOnce.add(key);
      log(`settled ${s.transaction.slice(0, 12)}… then failed the delivery on purpose (503)`);
      return res.status(503).json({ error: "simulated delivery failure after settlement" });
    }
    log(`settled ${s.transaction.slice(0, 12)}… delivered ${body.length} bytes with receipt`);
    res.status(200).set("PAYMENT-RESPONSE", encodePaymentResponseHeader(s)).set(RECEIPT_HEADER, encodeReceipt(receipt)).type("application/json").send(body);
  };
}

const app = express();
const series = () => ({ series: [1, 2, 3], as_of: new Date().toISOString() });
app.get("/api/paid", (req, res) => paid("5000", "mock catalog data", series)(req, res).catch((e) => res.status(500).json({ error: String(e) })));
app.get("/api/flaky", (req, res) => paid("5000", "mock catalog data (first delivery fails)", series, { flaky: true })(req, res).catch((e) => res.status(500).json({ error: String(e) })));
app.get("/api/broken", (req, res) => paid("5000", "mock catalog data (never delivered)", series, { broken: true })(req, res).catch((e) => res.status(500).json({ error: String(e) })));
app.get("/api/expensive", (req, res) => paid("20000", "mock catalog data (over cap)", () => ({ series: [] }))(req, res).catch((e) => res.status(500).json({ error: String(e) })));
app.get("/api/free", (_req, res) => { res.json({ free: true }); });
app.listen(PORT, () => log(`on http://127.0.0.1:${PORT} payTo=${kp.publicKey.toBase58()} network=${network}`));
