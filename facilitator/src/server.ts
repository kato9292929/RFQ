// Minimal x402 facilitator (verify + settle only) for running the E2E on a local
// validator, where the public facilitator cannot reach. On devnet the agents use
// the public facilitator at FACILITATOR_URL (https://x402.org/facilitator) instead.
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { RPC_URL, X402_NETWORK, env, loadKeypair } from "../../lib/common.js";

const PORT = Number(env("FACILITATOR_PORT", "8790"));
const kp = loadKeypair(env("FACILITATOR_KEYPAIR", ".keys/facilitator.json"));
const signer = await createKeyPairSignerFromBytes(kp.secretKey);
const facilitator = registerExactSvmScheme(new x402Facilitator(), {
  signer: toFacilitatorSvmSigner(signer, { defaultRpcUrl: RPC_URL() }),
  networks: X402_NETWORK() as `${string}:${string}`,
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", async (req, res) => {
  try {
    res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements));
  } catch (e: any) {
    res.status(400).json({ isValid: false, invalidReason: String(e?.message ?? e) });
  }
});

// FACILITATOR_SIMULATE_SETTLE_TIMEOUT=N: for the first N settles, submit the transfer
// (it lands) but answer the seller with a failure — reproduces the devnet case where
// the seller's /settle wait expired while the tx still confirmed. Local testing only.
let simulateTimeouts = Number(process.env.FACILITATOR_SIMULATE_SETTLE_TIMEOUT ?? "0");

app.post("/settle", async (req, res) => {
  try {
    const r = await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements);
    if (simulateTimeouts > 0 && r.success) {
      simulateTimeouts--;
      console.log(`[settle] SIMULATED TIMEOUT: tx ${r.transaction} landed, reporting failure to the seller`);
      return res.status(400).json({ success: false, errorReason: "simulated settlement timeout", transaction: "", network: X402_NETWORK() });
    }
    console.log(`[settle] success=${r.success} tx=${r.transaction} network=${r.network}`);
    res.json(r);
  } catch (e: any) {
    console.error("[settle] error", e);
    res.status(400).json({ success: false, errorReason: String(e?.message ?? e), transaction: "", network: X402_NETWORK() });
  }
});

app.listen(PORT, () => {
  console.log(`local facilitator on http://127.0.0.1:${PORT} feePayer=${signer.address} network=${X402_NETWORK()} rpc=${RPC_URL()}`);
});
