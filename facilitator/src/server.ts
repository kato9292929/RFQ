// Minimal x402 facilitator (verify + settle only) for running the E2E on a local
// validator, where the public facilitator cannot reach. On devnet the agents use
// the public facilitator at FACILITATOR_URL (https://x402.org/facilitator) instead.
//
// FACILITATOR_UPSTREAM=<url>: pass-through mode. /supported, /verify and /settle are
// forwarded to that facilitator (e.g. https://x402.org/facilitator on devnet); no local
// key is used. Combined with FACILITATOR_SIMULATE_SETTLE_TIMEOUT this reproduces, on a
// real network, a transfer that lands while the seller is told settlement failed.
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { RPC_URL, X402_NETWORK, env, loadKeypair } from "../../lib/common.js";

const PORT = Number(env("FACILITATOR_PORT", "8790"));
const UPSTREAM = process.env.FACILITATOR_UPSTREAM?.replace(/\/$/, "");

type Backend = {
  supported(): Promise<unknown>;
  verify(payload: any, req: any): Promise<unknown>;
  settle(payload: any, req: any): Promise<{ success: boolean; transaction: string; network: string }>;
};

async function upstream(path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${UPSTREAM}${path}`, body === undefined
    ? {}
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`upstream ${path} ${r.status}: ${text.slice(0, 200)}`);
  }
}

async function makeBackend(): Promise<Backend> {
  if (UPSTREAM) {
    return {
      supported: () => upstream("/supported"),
      verify: (p, q) => upstream("/verify", { x402Version: p?.x402Version, paymentPayload: p, paymentRequirements: q }),
      settle: (p, q) => upstream("/settle", { x402Version: p?.x402Version, paymentPayload: p, paymentRequirements: q }),
    };
  }
  const kp = loadKeypair(env("FACILITATOR_KEYPAIR", ".keys/facilitator.json"));
  const signer = await createKeyPairSignerFromBytes(kp.secretKey);
  const f = registerExactSvmScheme(new x402Facilitator(), {
    signer: toFacilitatorSvmSigner(signer, { defaultRpcUrl: RPC_URL() }),
    networks: X402_NETWORK() as `${string}:${string}`,
  });
  return {
    supported: async () => f.getSupported(),
    verify: (p, q) => f.verify(p, q),
    settle: (p, q) => f.settle(p, q) as any,
  };
}
const backend = await makeBackend();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/supported", async (_req, res) => {
  try {
    res.json(await backend.supported());
  } catch (e: any) {
    res.status(502).json({ error: String(e?.message ?? e) });
  }
});

app.post("/verify", async (req, res) => {
  try {
    res.json(await backend.verify(req.body.paymentPayload, req.body.paymentRequirements));
  } catch (e: any) {
    res.status(400).json({ isValid: false, invalidReason: String(e?.message ?? e) });
  }
});

// FACILITATOR_SIMULATE_SETTLE_TIMEOUT=N: for the first N settles, submit the transfer
// (it lands) but answer the seller with a failure — reproduces the devnet case where
// the seller's /settle wait expired while the tx still confirmed. Testing only.
let simulateTimeouts = Number(process.env.FACILITATOR_SIMULATE_SETTLE_TIMEOUT ?? "0");

app.post("/settle", async (req, res) => {
  try {
    const r = await backend.settle(req.body.paymentPayload, req.body.paymentRequirements);
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
  console.log(`facilitator on http://127.0.0.1:${PORT} ${UPSTREAM ? `(pass-through to ${UPSTREAM})` : "(local signer)"} network=${X402_NETWORK()} rpc=${RPC_URL()}`);
});
