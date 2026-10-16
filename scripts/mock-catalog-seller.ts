// Local stand-in for a catalog seller: an ordinary x402 endpoint that knows nothing about
// RFQs. Localnet tests only. Paths:
//   /api/paid       402, 0.005 USDC   → becomes a catalog quote
//   /api/expensive  402, 0.02 USDC    → over the $0.01 per-call cap, skipped
//   /api/free       200               → not a 402, skipped
import express from "express";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { FACILITATOR_URL, RPC_URL, X402_NETWORK, connection, env, loadKeypair } from "../lib/common.js";

const kp = loadKeypair(env("MOCK_CATALOG_KEYPAIR", ".keys/catalog_seller.json"));
const mint = new PublicKey(env("USDC_MINT"));
const PORT = Number(env("MOCK_CATALOG_PORT", "8810"));
await getOrCreateAssociatedTokenAccount(connection(), kp, mint, kp.publicKey);

const network = X402_NETWORK() as `${string}:${string}`;
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL() })).register(network, new ExactSvmScheme({ rpcUrl: RPC_URL() }));
const price = (amount: string) => ({ scheme: "exact" as const, network, payTo: kp.publicKey.toBase58(), price: { asset: mint.toBase58(), amount, extra: { name: "USDC", decimals: 6 } } });
const app = express();
app.use(paymentMiddleware({
  "GET /api/paid": { accepts: price("5000"), description: "mock catalog data", mimeType: "application/json" },
  "GET /api/expensive": { accepts: price("20000"), description: "mock catalog data (over cap)", mimeType: "application/json" },
}, server));
app.get("/api/paid", (_req, res) => { res.json({ series: [1, 2, 3], as_of: new Date().toISOString() }); });
app.get("/api/expensive", (_req, res) => { res.json({ series: [] }); });
app.get("/api/free", (_req, res) => { res.json({ free: true }); });
app.listen(PORT, () => console.log(`mock catalog seller on http://127.0.0.1:${PORT} payTo=${kp.publicKey.toBase58()}`));
