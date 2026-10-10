// Buyer agent: posts an RFQ, collects quotes until the deadline, awards the
// cheapest (ties → earliest), pays the winner exactly once over x402, and
// records the fulfillment on-chain. Every step is appended to log/YYYY-MM-DD.jsonl.
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { Ajv } from "ajv";
import {
  INDEXER_URL, ROOT, RPC_URL, X402_NETWORK,
  REASONS, appendLog, connection, env, explorerTx, fmtUsdc, loadKeypair, pdas, program, retry, sha256, sleep,
  type Reason,
} from "../../../lib/common.js";

const { BN } = anchor;

const kp = loadKeypair(env("BUYER_KEYPAIR"));
const MAX_PRICE = BigInt(env("BUYER_MAX_PRICE", "100000")); // 0.10 USDC
const WINDOW = Number(env("BUYER_RFQ_WINDOW_SEC", "90"));
const specText = process.env.BUYER_SPEC_FILE
  ? readFileSync(resolve(ROOT, process.env.BUYER_SPEC_FILE), "utf8")
  : JSON.stringify({ category: "market-data", fields: ["endpoint_count", "host_count"], freshness_hours: 24 });

const prog = program(kp);
const P = pdas(prog.programId);
const conn = connection();
const me = kp.publicKey;
const runId = `run-${Date.now()}`;
const log = (...a: unknown[]) => console.log("[buyer]", ...a);
const SCENARIO = process.env.BUYER_SCENARIO ?? "default";
const record = (step: string, data: Record<string, unknown>) => appendLog({ actor: "buyer", run: runId, scenario: SCENARIO, step, ...data });

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

// 1. spec → indexer
const { spec_hash, spec_uri } = await json<{ spec_hash: string; spec_uri: string }>(`${INDEXER_URL()}/specs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: specText,
});
log(`spec stored hash=${spec_hash}`);

// 2. post_rfq
const cfg = await prog.account.config.fetch(P.config());
const nonce = BigInt(Date.now());
const rfq = P.rfq(me, nonce);
const deadline = Math.floor(Date.now() / 1000) + WINDOW;
const postSig = await prog.methods
  .postRfq(new BN(nonce.toString()), [...Buffer.from(spec_hash, "hex")], spec_uri, new BN(MAX_PRICE.toString()), new BN(deadline))
  .accountsPartial({ buyer: me })
  .rpc();
log(`post_rfq rfq=${rfq.toBase58()} max=${fmtUsdc(MAX_PRICE)} deadline=${new Date(deadline * 1000).toISOString()} tx=${postSig}`);
record("post_rfq", {
  rfq: rfq.toBase58(), buyer: me.toBase58(), nonce: nonce.toString(), spec_hash, spec_uri, spec: JSON.parse(specText),
  max_price: MAX_PRICE.toString(), max_price_usdc: fmtUsdc(MAX_PRICE), deadline, tx: postSig, explorer: explorerTx(postSig),
});

// 3. collect quotes until the deadline
let seen = 0;
while (Math.floor(Date.now() / 1000) < deadline) {
  const d = await json<any>(`${INDEXER_URL()}/rfqs/${rfq.toBase58()}`).catch(() => undefined);
  if (d && d.quotes.length !== seen) {
    seen = d.quotes.length;
    log(`quotes so far: ${d.quotes.map((q: any) => `${q.seller.slice(0, 6)}=${q.price_usdc}`).join(", ")}`);
  }
  await sleep(3000);
}
const detail = await retry(() => json<any>(`${INDEXER_URL()}/rfqs/${rfq.toBase58()}`), "indexer rfq detail");
const spec = JSON.parse(specText) as {
  category: string; fields?: string[]; freshness_hours?: number; max_latency_ms?: number; schema?: object;
};
const nowS = Math.floor(Date.now() / 1000);
const excluded: { quote: string; seller: string; why: string }[] = [];
const eligible = (detail.quotes as any[]).filter((q) => {
  const why =
    q.expires_at <= nowS + 30 ? "quote expires too soon"
    : !q.endpoint_hash_ok ? "endpoint_hash does not match endpoint_uri"
    : BigInt(q.price) > MAX_PRICE ? "price above max_price"
    : spec.max_latency_ms !== undefined && !q.sla ? `no SLA declared (spec max_latency_ms=${spec.max_latency_ms})`
    : spec.max_latency_ms !== undefined && q.sla.max_latency_ms > spec.max_latency_ms
      ? `SLA ${q.sla.max_latency_ms}ms > spec max_latency_ms=${spec.max_latency_ms}`
    : "";
  if (why) excluded.push({ quote: q.pubkey, seller: q.seller, why });
  return !why;
});

/** Slot of the transaction that created the quote (oldest signature touching the PDA). */
async function creationSlot(quote: string): Promise<number> {
  const sigs = await retry(() => conn.getSignaturesForAddress(new PublicKey(quote), { limit: 20 }), "getSignaturesForAddress");
  return sigs.length ? sigs[sigs.length - 1].slot : Number.MAX_SAFE_INTEGER;
}

// Cheapest wins. Equal price → earlier creation slot. Same slot → uniform random
// (a pubkey-order tie-break would let vanity keys win every tie).
let tieBreak: Record<string, unknown> | null = null;
let win: any = undefined;
if (eligible.length) {
  const best = eligible.reduce((m, q) => (BigInt(q.price) < m ? BigInt(q.price) : m), BigInt(eligible[0].price));
  const tied = eligible.filter((q) => BigInt(q.price) === best);
  if (tied.length === 1) win = tied[0];
  else {
    const slots = await Promise.all(tied.map(async (q) => ({ q, slot: await creationSlot(q.pubkey) })));
    const minSlot = Math.min(...slots.map((x) => x.slot));
    const first = slots.filter((x) => x.slot === minSlot);
    const pick = first.length === 1 ? 0 : randomInt(first.length);
    win = first[pick].q;
    tieBreak = {
      method: first.length === 1 ? "earliest_slot" : "random_within_slot",
      candidates: slots.map((x) => ({ quote: x.q.pubkey, seller: x.q.seller, slot: x.slot })),
      ...(first.length > 1 ? { random_index: pick, of: first.length } : {}),
    };
  }
}
record("quotes_collected", {
  rfq: rfq.toBase58(),
  quotes: detail.quotes.map((q: any) => ({
    quote: q.pubkey, seller: q.seller, price: q.price, endpoint_uri: q.endpoint_uri, created_at: q.created_at,
    sla_ms: q.sla?.max_latency_ms ?? null,
  })),
  excluded,
  tie_break: tieBreak,
});
if (!win) {
  log(`no valid quotes — cancelling RFQ${excluded.length ? ` (excluded: ${excluded.map((e) => e.why).join("; ")})` : ""}`);
  const sig = await prog.methods.cancelRfq().accountsPartial({ buyer: me, rfq }).rpc();
  record("cancel_rfq", { rfq: rfq.toBase58(), excluded, tx: sig, explorer: explorerTx(sig) });
  process.exit(2);
}
log(`winner ${win.seller} price=${win.price_usdc} USDC sla=${win.sla?.max_latency_ms ?? "-"}ms of ${detail.quotes.length} quote(s)` +
  (excluded.length ? `; excluded: ${excluded.map((e) => `${e.seller.slice(0, 6)} (${e.why})`).join(", ")}` : "") +
  (tieBreak ? `; tie-break=${tieBreak.method}` : ""));

// 4. award (pays the 1% taker fee to the treasury inside the program)
const buyerUsdc = getAssociatedTokenAddressSync(cfg.usdcMint, me);
const tBefore = (await getAccount(conn, cfg.treasury)).amount;
const awardSig = await prog.methods
  .award()
  .accountsPartial({ buyer: me, rfq, quote: new PublicKey(win.pubkey), buyerUsdc, treasury: cfg.treasury, tokenProgram: TOKEN_PROGRAM_ID })
  .rpc();
const fee = (await getAccount(conn, cfg.treasury)).amount - tBefore;
log(`award tx=${awardSig} fee=${fmtUsdc(fee)} USDC → treasury ${cfg.treasury.toBase58()}`);
record("award", {
  rfq: rfq.toBase58(), quote: win.pubkey, seller: win.seller, price: win.price, price_usdc: win.price_usdc,
  fee: fee.toString(), fee_usdc: fmtUsdc(fee), fee_bps: cfg.feeBps, treasury: cfg.treasury.toBase58(),
  tx: awardSig, explorer: explorerTx(awardSig),
});

// 5. x402: GET → 402 → signed GET (exactly one paid call)
const signer = await createKeyPairSignerFromBytes(kp.secretKey);
const network = X402_NETWORK() as `${string}:${string}`;
const client = x402Client.fromConfig({
  schemes: [{ network, client: new ExactSvmScheme(signer, { rpcUrl: RPC_URL() }) }],
  spendControls: { allowedAssets: [{ network, asset: cfg.usdcMint.toBase58(), maxAmountPerPayment: win.price }] },
  // Only pay the awarded seller, the awarded price, in the configured mint.
  policies: [
    (_v, reqs) =>
      reqs.filter((r: any) => r.payTo === win.seller && r.amount === win.price && r.asset === cfg.usdcMint.toBase58() && r.scheme === "exact"),
  ],
});
const http = new x402HTTPClient(client);

const first = await fetch(win.endpoint_uri);
const firstBody = await first.text();
if (first.status !== 402) throw new Error(`expected 402 from seller, got ${first.status}: ${firstBody.slice(0, 300)}`);
let firstJson: unknown;
try {
  firstJson = JSON.parse(firstBody);
} catch {
  firstJson = undefined;
}
const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), firstJson);
const req0 = required.accepts[0];
log(`402 received: ${req0.scheme} ${req0.network} amount=${req0.amount} asset=${req0.asset} payTo=${req0.payTo}`);
record("x402_payment_required", { rfq: rfq.toBase58(), endpoint_uri: win.endpoint_uri, accepts: required.accepts });

const payload = await http.createPaymentPayload(required);
// Measured latency = the paid call end to end (request → settled response body), which
// is what the seller's declared SLA covers.
const t0 = performance.now();
const paid = await fetch(win.endpoint_uri, { headers: http.encodePaymentSignatureHeader(payload) });
const bodyBytes = Buffer.from(await paid.arrayBuffer());
const latencyMs = Math.round(performance.now() - t0);
if (paid.status !== 200) throw new Error(`paid request failed ${paid.status}: ${bodyBytes.toString().slice(0, 500)}`);
const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
if (!settle.success || !settle.transaction) throw new Error(`settlement failed: ${JSON.stringify(settle)}`);
const responseHash = sha256(bodyBytes);
log(`paid ${fmtUsdc(win.price)} USDC tx=${settle.transaction} response_sha256=${responseHash.toString("hex")}`);
record("x402_paid", {
  rfq: rfq.toBase58(), seller: win.seller, amount: win.price, amount_usdc: win.price_usdc, network: settle.network,
  payment_tx: settle.transaction, explorer: explorerTx(settle.transaction), payer: settle.payer,
  response_sha256: responseHash.toString("hex"), response_bytes: bodyBytes.length, latency_ms: latencyMs,
  response_preview: bodyBytes.toString("utf8").slice(0, 400),
});

// 6. acceptance test → record_fulfillment or record_rejection
function accept(): { ok: true } | { ok: false; reason: Reason; detail: unknown } {
  let body: any;
  try {
    body = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_response", detail: "body is not JSON" };
  }
  const data = body?.data;
  if (!data || typeof data !== "object") return { ok: false, reason: "invalid_response", detail: "no data object" };
  const missing = (spec.fields ?? []).filter((f) => data[f] === undefined || data[f] === null);
  if (missing.length) return { ok: false, reason: "missing_fields", detail: { missing } };
  if (spec.freshness_hours !== undefined) {
    const gen = Date.parse(body?.source?.generated_at ?? "");
    const ageH = (Date.now() - gen) / 3_600_000;
    if (!Number.isFinite(ageH) || ageH > spec.freshness_hours)
      return { ok: false, reason: "stale_data", detail: { generated_at: body?.source?.generated_at, age_hours: ageH } };
  }
  if (spec.schema) {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(spec.schema);
    if (!validate(data)) return { ok: false, reason: "schema_mismatch", detail: validate.errors };
  }
  return { ok: true };
}
const verdict = accept();
const sigBytes = bs58.decode(settle.transaction);
if (sigBytes.length !== 64) throw new Error(`payment signature is ${sigBytes.length} bytes, expected 64`);
const quotePk = new PublicKey(win.pubkey);

if (verdict.ok) {
  const fulfilSig = await prog.methods
    .recordFulfillment([...sigBytes], [...responseHash])
    .accountsPartial({ buyer: me, rfq, quote: quotePk })
    .rpc();
  log(`record_fulfillment tx=${fulfilSig}`);
  record("record_fulfillment", {
    rfq: rfq.toBase58(), fulfillment: P.fulfillment(rfq).toBase58(), payment_tx: settle.transaction,
    response_sha256: responseHash.toString("hex"), tx: fulfilSig, explorer: explorerTx(fulfilSig),
  });
} else {
  const code = REASONS[verdict.reason].code;
  const rejSig = await prog.methods
    .recordRejection([...sigBytes], [...responseHash], code)
    .accountsPartial({ buyer: me, rfq, quote: quotePk })
    .rpc();
  log(`record_rejection reason=${verdict.reason}(${code}) tx=${rejSig} — paid, no refund (no escrow)`);
  record("record_rejection", {
    rfq: rfq.toBase58(), rejection: P.rejection(rfq).toBase58(), seller: win.seller, payment_tx: settle.transaction,
    response_sha256: responseHash.toString("hex"), reason: verdict.reason, reason_code: code, detail: verdict.detail,
    tx: rejSig, explorer: explorerTx(rejSig),
  });
}

// 7. measured latency against the declared SLA (if the seller declared one)
const slaPk = P.sla(quotePk);
if (await prog.account.sla.fetchNullable(slaPk)) {
  const latSig = await prog.methods.recordLatency(latencyMs).accountsPartial({ buyer: me, rfq, quote: quotePk, sla: slaPk }).rpc();
  const sla = await prog.account.sla.fetch(slaPk);
  const met = latencyMs <= sla.maxLatencyMs;
  log(`record_latency measured=${latencyMs}ms declared=${sla.maxLatencyMs}ms met=${met} tx=${latSig}`);
  record("record_latency", {
    rfq: rfq.toBase58(), quote: win.pubkey, sla: slaPk.toBase58(), declared_ms: sla.maxLatencyMs, measured_ms: latencyMs, met,
    tx: latSig, explorer: explorerTx(latSig),
  });
}

// 8. ask the indexer to verify the payment against the chain
const endpoint = verdict.ok ? "fulfillments" : "rejections";
let mine: any;
for (let i = 0; i < 10; i++) {
  const all = await json<any[]>(`${INDEXER_URL()}/${endpoint}`).catch(() => [] as any[]);
  mine = all.find((f) => f.rfq === rfq.toBase58());
  if (mine?.verified) break;
  await sleep(3000);
}
record("indexer_verification", {
  rfq: rfq.toBase58(), outcome: verdict.ok ? "fulfilled" : "rejected", verified: mine?.verified ?? false, verification: mine?.verification,
});
console.log(JSON.stringify(mine, null, 2));
log(`outcome=${verdict.ok ? "fulfilled" : "rejected"} payment verified=${mine?.verified}`);
// exit: 0 fulfilled+verified, 3 rejected (payment verified), 1 anything unverified
process.exit(!mine?.verified ? 1 : verdict.ok ? 0 : 3);
