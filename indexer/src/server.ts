// RFQ market indexer: reads program accounts from the RPC and serves them as HTTP/JSON.
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { ROOT, STATUS, connection, env, fmtUsdc, program, sha256 } from "../../lib/common.js";

const PORT = Number(env("INDEXER_PORT", "8787"));
const PUBLIC_URL = env("INDEXER_PUBLIC_URL", `http://127.0.0.1:${PORT}`);
const DATA_DIR = resolve(ROOT, env("INDEXER_DATA_DIR", "indexer/.data"));
const SPEC_DIR = resolve(DATA_DIR, "specs");
mkdirSync(SPEC_DIR, { recursive: true });

const prog = program();
const conn = connection();

const hex = (b: number[] | Uint8Array) => Buffer.from(b).toString("hex");
const now = () => Math.floor(Date.now() / 1000);

type RfqAcc = Awaited<ReturnType<typeof prog.account.rfq.fetch>>;
type QuoteAcc = Awaited<ReturnType<typeof prog.account.quote.fetch>>;
type FulfillmentAcc = Awaited<ReturnType<typeof prog.account.fulfillment.fetch>>;

function rfqJson(pk: PublicKey, a: RfqAcc, quotes?: { publicKey: PublicKey; account: QuoteAcc }[]) {
  const status = STATUS[a.status] ?? "unknown";
  const deadline = a.deadline.toNumber();
  const quotesLive = quotes?.some((q) => q.account.expiresAt.toNumber() > now());
  // On-chain status stays Open until awarded/cancelled. "expired" is derived:
  // open, past deadline, and no live quote left to award.
  let effective: string = status;
  if (status === "open" && deadline <= now()) effective = quotes && !quotesLive ? "expired" : "awaiting_award";
  return {
    pubkey: pk.toBase58(),
    buyer: a.buyer.toBase58(),
    nonce: a.nonce.toString(),
    spec_hash: hex(a.specHash),
    spec_uri: a.specUri,
    max_price: a.maxPrice.toString(),
    max_price_usdc: fmtUsdc(a.maxPrice.toString()),
    deadline,
    status,
    effective_status: effective,
    accepting_quotes: status === "open" && deadline > now(),
    awarded_quote: a.awardedQuote?.toBase58() ?? null,
    created_at: a.createdAt.toNumber(),
  };
}

function quoteJson(pk: PublicKey, q: QuoteAcc) {
  return {
    pubkey: pk.toBase58(),
    rfq: q.rfq.toBase58(),
    seller: q.seller.toBase58(),
    price: q.price.toString(),
    price_usdc: fmtUsdc(q.price.toString()),
    endpoint_hash: hex(q.endpointHash),
    endpoint_uri: q.endpointUri,
    endpoint_hash_ok: hex(sha256(q.endpointUri)) === hex(q.endpointHash),
    expires_at: q.expiresAt.toNumber(),
    created_at: q.createdAt.toNumber(),
  };
}

const rfqFilter = (rfq: PublicKey) => [{ memcmp: { offset: 8, bytes: rfq.toBase58() } }];

// ---- payment verification -------------------------------------------------

type Verification = { verified: boolean; reason: string; checked_at: number; details?: Record<string, unknown> };
const verifyCache = new Map<string, Verification>();

/**
 * Check that the x402 payment tx actually moved `quote.price` of the configured
 * USDC mint from the RFQ buyer to the quoting seller, and succeeded.
 */
async function verifyPayment(sigB58: string, rfq: RfqAcc, quote: QuoteAcc, usdcMint: string): Promise<Verification> {
  const cached = verifyCache.get(sigB58);
  if (cached?.verified) return cached;
  const done = (verified: boolean, reason: string, details?: Record<string, unknown>) => {
    const v = { verified, reason, checked_at: now(), details };
    verifyCache.set(sigB58, v);
    return v;
  };
  const tx = await conn.getParsedTransaction(sigB58, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return done(false, "transaction not found");
  if (tx.meta?.err) return done(false, `transaction failed: ${JSON.stringify(tx.meta.err)}`);
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const delta = (owner: string) => {
    const amt = (arr: typeof pre) =>
      arr.filter((b) => b.mint === usdcMint && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    return amt(post) - amt(pre);
  };
  const seller = quote.seller.toBase58();
  const buyer = rfq.buyer.toBase58();
  const sellerDelta = delta(seller);
  const buyerDelta = delta(buyer);
  const price = BigInt(quote.price.toString());
  const details = {
    mint: usdcMint,
    seller,
    buyer,
    expected_amount: price.toString(),
    seller_received: sellerDelta.toString(),
    buyer_sent: (-buyerDelta).toString(),
    slot: tx.slot,
    block_time: tx.blockTime,
  };
  if (sellerDelta !== price) return done(false, "seller USDC delta does not equal quote.price", details);
  if (-buyerDelta !== price) return done(false, "buyer USDC delta does not equal quote.price", details);
  return done(true, "USDC transfer buyer→seller of quote.price confirmed", details);
}

// ---- HTTP ------------------------------------------------------------------

const app = express();
app.use((_req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  next();
});

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => res.status(500).json({ error: String(e?.message ?? e) }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, program_id: prog.programId.toBase58(), rpc: conn.rpcEndpoint });
});

app.get(
  "/config",
  wrap(async (_req, res) => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
    const c = await prog.account.config.fetch(pda);
    res.json({
      pubkey: pda.toBase58(),
      authority: c.authority.toBase58(),
      treasury: c.treasury.toBase58(),
      fee_bps: c.feeBps,
      usdc_mint: c.usdcMint.toBase58(),
    });
  }),
);

app.get(
  "/rfqs",
  wrap(async (req, res) => {
    const want = req.query.status as string | undefined;
    const [rfqs, quotes] = await Promise.all([prog.account.rfq.all(), prog.account.quote.all()]);
    const byRfq = new Map<string, typeof quotes>();
    for (const q of quotes) {
      const k = q.account.rfq.toBase58();
      byRfq.set(k, [...(byRfq.get(k) ?? []), q]);
    }
    let out = rfqs.map((r) => ({
      ...rfqJson(r.publicKey, r.account, byRfq.get(r.publicKey.toBase58()) ?? []),
      quote_count: byRfq.get(r.publicKey.toBase58())?.length ?? 0,
    }));
    // status=open means "accepting quotes now" (what sellers poll for).
    if (want === "open") out = out.filter((r) => r.accepting_quotes);
    else if (want) out = out.filter((r) => r.status === want || r.effective_status === want);
    out.sort((a, b) => b.created_at - a.created_at);
    res.json(out);
  }),
);

app.get(
  "/rfqs/:pubkey",
  wrap(async (req, res) => {
    const pk = new PublicKey(req.params.pubkey);
    const r = await prog.account.rfq.fetchNullable(pk);
    if (!r) return res.status(404).json({ error: "rfq not found" });
    const quotes = await prog.account.quote.all(rfqFilter(pk));
    const [fpk] = PublicKey.findProgramAddressSync([Buffer.from("fulfillment"), pk.toBuffer()], prog.programId);
    const f = await prog.account.fulfillment.fetchNullable(fpk);
    res.json({
      ...rfqJson(pk, r, quotes),
      quotes: quotes.map((q) => quoteJson(q.publicKey, q.account)).sort((a, b) => Number(BigInt(a.price) - BigInt(b.price))),
      fulfillment: f ? { pubkey: fpk.toBase58(), payment_sig: bs58.encode(Buffer.from(f.paymentSig)), response_hash: hex(f.responseHash) } : null,
    });
  }),
);

app.get(
  "/quotes",
  wrap(async (req, res) => {
    const seller = req.query.seller as string | undefined;
    const filters = seller ? [{ memcmp: { offset: 8 + 32, bytes: new PublicKey(seller).toBase58() } }] : [];
    const quotes = await prog.account.quote.all(filters);
    res.json(quotes.map((q) => quoteJson(q.publicKey, q.account)).sort((a, b) => b.created_at - a.created_at));
  }),
);

async function fulfillmentJson(pk: PublicKey, f: FulfillmentAcc, usdcMint: string) {
  const sig = bs58.encode(Buffer.from(f.paymentSig));
  const [rfq, quote] = await Promise.all([prog.account.rfq.fetch(f.rfq), prog.account.quote.fetch(f.quote)]);
  let v: Verification;
  try {
    v = await verifyPayment(sig, rfq, quote, usdcMint);
  } catch (e: any) {
    v = { verified: false, reason: `verification error: ${e?.message ?? e}`, checked_at: now() };
  }
  return {
    pubkey: pk.toBase58(),
    rfq: f.rfq.toBase58(),
    quote: f.quote.toBase58(),
    buyer: rfq.buyer.toBase58(),
    seller: quote.seller.toBase58(),
    price: quote.price.toString(),
    price_usdc: fmtUsdc(quote.price.toString()),
    endpoint_uri: quote.endpointUri,
    payment_sig: sig,
    response_hash: hex(f.responseHash),
    fulfilled_at: f.fulfilledAt.toNumber(),
    verified: v.verified,
    verification: v,
  };
}

async function usdcMint(): Promise<string> {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
  return (await prog.account.config.fetch(pda)).usdcMint.toBase58();
}

app.get(
  "/fulfillments",
  wrap(async (_req, res) => {
    const mint = await usdcMint();
    const all = await prog.account.fulfillment.all();
    const out = await Promise.all(all.map((f) => fulfillmentJson(f.publicKey, f.account, mint)));
    res.json(out.sort((a, b) => b.fulfilled_at - a.fulfilled_at));
  }),
);

app.get(
  "/stats",
  wrap(async (_req, res) => {
    const [rfqs, quotes, fulfillments] = await Promise.all([
      prog.account.rfq.all(),
      prog.account.quote.all(),
      prog.account.fulfillment.all(),
    ]);
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
    const cfg = await prog.account.config.fetchNullable(pda);
    const qByPk = new Map(quotes.map((q) => [q.publicKey.toBase58(), q.account]));
    const awarded = rfqs.filter((r) => r.account.awardedQuote);
    const awardedPrices = awarded.map((r) => BigInt(qByPk.get(r.account.awardedQuote!.toBase58())?.price.toString() ?? "0"));
    const sum = awardedPrices.reduce((s, p) => s + p, 0n);
    const feeBps = BigInt(cfg?.feeBps ?? 0);
    const fees = awardedPrices.reduce((s, p) => s + (p * feeBps) / 10_000n, 0n);
    const byStatus: Record<string, number> = {};
    for (const r of rfqs) byStatus[STATUS[r.account.status]] = (byStatus[STATUS[r.account.status]] ?? 0) + 1;
    res.json({
      rfq_count: rfqs.length,
      quote_count: quotes.length,
      by_status: byStatus,
      awarded_count: awarded.length,
      fulfilled_count: fulfillments.length,
      award_rate: rfqs.length ? awarded.length / rfqs.length : 0,
      avg_awarded_price: awarded.length ? fmtUsdc(sum / BigInt(awarded.length)) : null,
      fees_total_usdc: fmtUsdc(fees),
    });
  }),
);

// Spec store: the exact bytes the buyer POSTs are hashed and stored.
app.post("/specs", express.raw({ type: "*/*", limit: "64kb" }), (req, res) => {
  const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  try {
    JSON.parse(body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "body must be JSON" });
  }
  const h = sha256(body).toString("hex");
  writeFileSync(resolve(SPEC_DIR, `${h}.json`), body);
  res.json({ spec_hash: h, spec_uri: `${PUBLIC_URL}/specs/${h}` });
});

app.get("/specs/:hash", (req, res) => {
  const h = req.params.hash;
  if (!/^[0-9a-f]{64}$/.test(h)) return res.status(400).json({ error: "bad hash" });
  const p = resolve(SPEC_DIR, `${h}.json`);
  if (!existsSync(p)) return res.status(404).json({ error: "spec not found" });
  res.type("application/json").send(readFileSync(p));
});

// Event subscription: log program events as they arrive (account reads stay the source of truth).
for (const ev of ["rfqPosted", "quoteSubmitted", "rfqAwarded", "rfqFulfilled"] as const) {
  prog.addEventListener(ev, (e: any, slot: number) => {
    const flat = Object.fromEntries(
      Object.entries(e).map(([k, v]: [string, any]) => [k, v?.toBase58?.() ?? (Array.isArray(v) ? hex(v) : v?.toString?.() ?? v)]),
    );
    console.log(`[event] ${ev} slot=${slot}`, JSON.stringify(flat));
  });
}

app.listen(PORT, () => {
  console.log(`indexer listening on ${PUBLIC_URL} program=${prog.programId.toBase58()} rpc=${conn.rpcEndpoint}`);
});
