// RFQ market indexer: reads program accounts from the RPC and serves them as HTTP/JSON.
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { ROOT, STATUS, X402_NETWORK, connection, env, fmtUsdc, pdas, program, reasonByCode, retry, sha256 } from "../../lib/common.js";
import { probeHost } from "../../lib/probe.js";
import {
  MEMO_PROGRAM_ID, SOLANA_MAINNET_CAIP2, USDC_BY_NETWORK, baseRpcUrl, checkUsdcTransfer, decodePaymentRef, isEvm, parseRecordMemo, verifyConnection,
  type RecordMemo,
} from "../../lib/payment-net.js";
import { checkEvmTransfer } from "../../lib/evm-pay.js";

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
type RejectionAcc = Awaited<ReturnType<typeof prog.account.rejection.fetch>>;
type SlaAcc = Awaited<ReturnType<typeof prog.account.sla.fetch>>;
const P = pdas(prog.programId);

function slaJson(pk: PublicKey, a: SlaAcc) {
  return {
    pubkey: pk.toBase58(),
    max_latency_ms: a.maxLatencyMs,
    measured_latency_ms: a.measured ? a.measuredLatencyMs : null,
    met: a.measured ? a.measuredLatencyMs <= a.maxLatencyMs : null,
    measured_at: a.measured ? a.measuredAt.toNumber() : null,
  };
}

/** SLA accounts keyed by quote pubkey (SLA lives in its own PDA so Quote keeps its layout). */
async function slaByQuote(): Promise<Map<string, ReturnType<typeof slaJson>>> {
  const all = await retry(() => prog.account.sla.all(), "sla.all");
  return new Map(all.map((s) => [s.account.quote.toBase58(), slaJson(s.publicKey, s.account)]));
}

type CatalogInfo = { host: string; pay_to: string; network: string; observed_at: number; recorded_by: string };

/** Catalog-quote markers keyed by quote pubkey. A quote with one is source "catalog". */
async function catalogByQuote(): Promise<Map<string, CatalogInfo>> {
  const all = await retry(() => prog.account.catalogQuote.all(), "catalogQuote.all");
  return new Map(all.map((c) => [c.account.quote.toBase58(), {
    host: c.account.host, pay_to: c.account.payTo, network: c.account.network,
    observed_at: c.account.observedAt.toNumber(), recorded_by: c.account.recordedBy.toBase58(),
  }]));
}

async function catalogFor(quote: PublicKey): Promise<CatalogInfo | undefined> {
  const c = await retry(() => prog.account.catalogQuote.fetchNullable(P.catalogQuote(quote)), "catalogQuote.fetchNullable");
  return c ? { host: c.host, pay_to: c.payTo, network: c.network, observed_at: c.observedAt.toNumber(), recorded_by: c.recordedBy.toBase58() } : undefined;
}

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

function quoteJson(pk: PublicKey, q: QuoteAcc, slas?: Map<string, ReturnType<typeof slaJson>>, catalogs?: Map<string, CatalogInfo>) {
  const catalog = catalogs?.get(pk.toBase58()) ?? null;
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
    sla: slas?.get(pk.toBase58()) ?? null,
    // "seller": the seller quoted itself. "catalog": the buyer recorded the price the
    // seller's own 402 advertised (x402 Endpoint catalog); the seller never signed.
    source: catalog ? "catalog" : "seller",
    catalog,
    // Network the seller is paid on (records are always on this program's cluster).
    pay_network: catalog?.network ?? X402_NETWORK(),
  };
}

/** The spec an RFQ committed to (by hash): local store first, then its spec_uri. */
const specCache = new Map<string, any>();
async function specOf(rfq: RfqAcc): Promise<any | null> {
  const h = hex(rfq.specHash);
  if (specCache.has(h)) return specCache.get(h);
  let bytes: Buffer | null = null;
  const p = resolve(SPEC_DIR, `${h}.json`);
  if (existsSync(p)) bytes = readFileSync(p);
  else {
    try {
      const r = await fetch(rfq.specUri, { signal: AbortSignal.timeout(5000) });
      if (r.ok) bytes = Buffer.from(await r.arrayBuffer());
    } catch {
      /* unavailable */
    }
  }
  const spec = bytes && sha256(bytes).toString("hex") === h ? JSON.parse(bytes.toString("utf8")) : null;
  if (spec) specCache.set(h, spec);
  return spec;
}

/** Our memo on the transaction that created a fulfillment/rejection account (see lib/payment-net.ts). */
const memoCache = new Map<string, { memo: RecordMemo | null; tx: string | null }>();
async function recordMemo(pda: PublicKey): Promise<{ memo: RecordMemo | null; tx: string | null }> {
  const k = pda.toBase58();
  if (memoCache.has(k)) return memoCache.get(k)!;
  const sigs = await retry(() => conn.getSignaturesForAddress(pda, { limit: 20 }, "confirmed"), "getSignaturesForAddress");
  const oldest = sigs[sigs.length - 1]?.signature ?? null;
  let memo: RecordMemo | null = null;
  if (oldest) {
    const tx = await retry(() => conn.getParsedTransaction(oldest, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }), "getParsedTransaction");
    for (const ix of tx?.transaction.message.instructions ?? []) {
      if (ix.programId.equals(MEMO_PROGRAM_ID) && "parsed" in ix && typeof ix.parsed === "string") memo = parseRecordMemo(ix.parsed) ?? memo;
    }
  }
  const out = { memo, tx: oldest };
  memoCache.set(k, out);
  return out;
}

const rfqFilter = (rfq: PublicKey) => [{ memcmp: { offset: 8, bytes: rfq.toBase58() } }];

// ---- payment verification -------------------------------------------------

type Verification = { verified: boolean; reason: string; checked_at: number; details?: Record<string, unknown> };
const verifyCache = new Map<string, Verification>();

/**
 * Check that the x402 payment tx actually moved `quote.price` of the configured
 * USDC mint from the RFQ buyer to the quoting seller, and succeeded.
 */
async function verifyPayment(sigB58: string | null, rfq: RfqAcc, quote: QuoteAcc, usdcMint: string, catalog?: CatalogInfo): Promise<Verification> {
  if (!sigB58) return { verified: false, reason: "no payment tx recorded (delivered without settlement)", checked_at: now() };
  const cached = verifyCache.get(sigB58);
  if (cached?.verified) return cached;
  const done = (verified: boolean, reason: string, details?: Record<string, unknown>) => {
    const v = { verified, reason, checked_at: now(), details };
    verifyCache.set(sigB58, v);
    return v;
  };
  // The payment happened on the network the catalog quote names (records stay on this cluster).
  const network = catalog?.network ?? X402_NETWORK();
  const own = network === X402_NETWORK();
  const payConn = isEvm(network) ? null : verifyConnection(network, conn);
  if (!payConn && !isEvm(network)) return done(false, `no RPC configured for payment network ${network}`, { network });
  const mint = own ? usdcMint : USDC_BY_NETWORK[network];
  // Sender: the record buyer on this cluster; on another network, the address the RFQ's spec
  // (hashed on-chain) committed as payer for that network.
  let buyer = rfq.buyer.toBase58();
  if (!own) {
    const spec = await specOf(rfq);
    const committed = spec?.payers?.[network];
    if (typeof committed !== "string") return done(false, `spec does not commit a payer for ${network}`, { network });
    buyer = committed;
  }
  // A catalog seller is paid at the address its 402 advertised, not at the per-host PDA.
  const seller = catalog?.pay_to ?? quote.seller.toBase58();
  const amount = BigInt(quote.price.toString());
  const r = await retry(
    () => (payConn
      ? checkUsdcTransfer(payConn, sigB58, { mint, buyer, seller, amount, network })
      : checkEvmTransfer(baseRpcUrl(), sigB58, { usdc: mint, buyer, seller, amount, network })),
    "checkTransfer",
  );
  return done(r.ok, r.reason, r.details);
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
    const c = await retry(() => prog.account.config.fetch(pda), "config.fetch");
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
    const rfqs = await retry(() => prog.account.rfq.all(), "rfq.all");
    const quotes = await retry(() => prog.account.quote.all(), "quote.all");
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
    const r = await retry(() => prog.account.rfq.fetchNullable(pk), "rfq.fetchNullable");
    if (!r) return res.status(404).json({ error: "rfq not found" });
    const quotes = await retry(() => prog.account.quote.all(rfqFilter(pk)), "quote.all");
    const [fpk] = PublicKey.findProgramAddressSync([Buffer.from("fulfillment"), pk.toBuffer()], prog.programId);
    const f = await retry(() => prog.account.fulfillment.fetchNullable(fpk), "fulfillment.fetchNullable");
    const rejPk = P.rejection(pk);
    const rej = await retry(() => prog.account.rejection.fetchNullable(rejPk), "rejection.fetchNullable");
    const slas = await slaByQuote();
    const catalogs = await catalogByQuote();
    res.json({
      ...rfqJson(pk, r, quotes),
      quotes: quotes.map((q) => quoteJson(q.publicKey, q.account, slas, catalogs)).sort((a, b) => Number(BigInt(a.price) - BigInt(b.price))),
      fulfillment: f ? { pubkey: fpk.toBase58(), payment_sig: bs58.encode(Buffer.from(f.paymentSig)), response_hash: hex(f.responseHash) } : null,
      rejection: rej
        ? { pubkey: rejPk.toBase58(), payment_sig: bs58.encode(Buffer.from(rej.paymentSig)), response_hash: hex(rej.responseHash),
            reason_code: rej.reasonCode, reason: reasonByCode(rej.reasonCode) }
        : null,
    });
  }),
);

app.get(
  "/quotes",
  wrap(async (req, res) => {
    const seller = req.query.seller as string | undefined;
    const filters = seller ? [{ memcmp: { offset: 8 + 32, bytes: new PublicKey(seller).toBase58() } }] : [];
    const quotes = await retry(() => prog.account.quote.all(filters), "quote.all");
    const slas = await slaByQuote();
    const catalogs = await catalogByQuote();
    const recovered = await recoveredRfqs();
    const rfqs = new Map((await retry(() => prog.account.rfq.all(), "rfq.all")).map((r) => [r.publicKey.toBase58(), r.account]));
    let out = quotes.map((q) => {
      const awarded = rfqs.get(q.account.rfq.toBase58())?.awardedQuote?.equals(q.publicKey) ?? false;
      // recovered: 1 when this quote was awarded and its paid delivery was recovered by a re-request
      return { ...quoteJson(q.publicKey, q.account, slas, catalogs), awarded, recovered: awarded && recovered.has(q.account.rfq.toBase58()) ? 1 : 0 };
    });
    const source = req.query.source as string | undefined;
    if (source) out = out.filter((q) => q.source === source);
    const payNet = req.query.pay_network as string | undefined;
    if (payNet) out = out.filter((q) => q.pay_network === payNet);
    res.json(out.sort((a, b) => b.created_at - a.created_at));
  }),
);

async function fulfillmentJson(pk: PublicKey, f: FulfillmentAcc, usdcMint: string) {
  const [rfq, quote] = await Promise.all([retry(() => prog.account.rfq.fetch(f.rfq), "rfq.fetch"), retry(() => prog.account.quote.fetch(f.quote), "quote.fetch")]);
  const catalog = await catalogFor(f.quote);
  const sig = decodePaymentRef(catalog?.network ?? X402_NETWORK(), f.paymentSig);
  let v: Verification;
  try {
    v = await verifyPayment(sig, rfq, quote, usdcMint, catalog);
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
    payment_ref_b58: bs58.encode(Buffer.from(f.paymentSig)),
    response_hash: hex(f.responseHash),
    fulfilled_at: f.fulfilledAt.toNumber(),
    ...(await recordExtras(pk, catalog)),
    verified: v.verified,
    verification: v,
  };
}

/** Payment network, payer, receipt and recovery for a fulfillment/rejection (from its memo). */
async function recordExtras(pk: PublicKey, catalog?: CatalogInfo) {
  const { memo, tx } = await recordMemo(pk).catch(() => ({ memo: null, tx: null }));
  const network = catalog?.network ?? X402_NETWORK();
  return {
    source: catalog ? "catalog" : "seller",
    host: catalog?.host ?? null,
    payment_network: network,
    // "mainnet": paid in mainnet USDC (Solana or Base); "record_cluster": paid on the cluster the records are on.
    payment_kind: network === X402_NETWORK() ? "record_cluster" : network === SOLANA_MAINNET_CAIP2 || network === "eip155:8453" ? "mainnet" : "other",
    // fulfilled | recovered | delivered_without_settlement (fulfillments); rejections carry `reason`
    outcome: memo?.outcome ?? (memo?.recovered ? "recovered" : null),
    payer: memo?.payer ?? null,
    receipt: memo?.receipt ?? null,
    receipt_signer: memo?.receipt_signer ?? null,
    recovered: memo?.recovered === true,
    rerequest: memo?.retry ?? null,
    first_status: memo?.first_status ?? null,
    record_tx: tx,
  };
}

/** Fulfilled RFQs that were recovered by a re-request, keyed by rfq pubkey. */
async function recoveredRfqs(): Promise<Set<string>> {
  return (await fulfillmentKinds()).recovered;
}

/** Fulfillment records by memo: recovered by a re-request / delivered without a settled payment. */
async function fulfillmentKinds(): Promise<{ recovered: Set<string>; withoutSettlement: Set<string> }> {
  const all = await retry(() => prog.account.fulfillment.all(), "fulfillment.all");
  const recovered = new Set<string>();
  const withoutSettlement = new Set<string>();
  for (const f of all) {
    const m = (await recordMemo(f.publicKey).catch(() => ({ memo: null }))).memo;
    if (m?.recovered) recovered.add(f.account.rfq.toBase58());
    if (m?.outcome === "delivered_without_settlement") withoutSettlement.add(f.account.rfq.toBase58());
  }
  return { recovered, withoutSettlement };
}

/** How many fulfillment/rejection records cite each payment tx (one payment must back one record). */
async function paymentUseCounts(): Promise<Map<string, number>> {
  const [fs, rs] = await Promise.all([
    retry(() => prog.account.fulfillment.all(), "fulfillment.all"),
    retry(() => prog.account.rejection.all(), "rejection.all"),
  ]);
  const m = new Map<string, number>();
  for (const x of [...fs, ...rs]) {
    if (x.account.paymentSig.every((b: number) => b === 0)) continue; // no payment landed
    const k = bs58.encode(Buffer.from(x.account.paymentSig));
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function reuseGuard<T extends { payment_sig: string | null; payment_ref_b58: string; verified: boolean; verification: Verification }>(rec: T, uses: Map<string, number>): T {
  const n = uses.get(rec.payment_ref_b58) ?? 0;
  if (n > 1) return { ...rec, verified: false, verification: { ...rec.verification, verified: false, reason: `payment tx is cited by ${n} records` } };
  return rec;
}

async function usdcMint(): Promise<string> {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
  return (await retry(() => prog.account.config.fetch(pda), "config.fetch")).usdcMint.toBase58();
}

app.get(
  "/fulfillments",
  wrap(async (_req, res) => {
    const mint = await usdcMint();
    const all = await retry(() => prog.account.fulfillment.all(), "fulfillment.all");
    const uses = await paymentUseCounts();
    const out = (await Promise.all(all.map((f) => fulfillmentJson(f.publicKey, f.account, mint)))).map((r) => reuseGuard(r, uses));
    res.json(out.sort((a, b) => b.fulfilled_at - a.fulfilled_at));
  }),
);

async function rejectionJson(pk: PublicKey, r: RejectionAcc, usdcMint: string) {
  const [rfq, quote] = await Promise.all([
    retry(() => prog.account.rfq.fetch(r.rfq), "rfq.fetch"),
    retry(() => prog.account.quote.fetch(r.quote), "quote.fetch"),
  ]);
  const catalog = await catalogFor(r.quote);
  const sig = decodePaymentRef(catalog?.network ?? X402_NETWORK(), r.paymentSig);
  let v: Verification;
  try {
    v = await verifyPayment(sig, rfq, quote, usdcMint, catalog);
  } catch (e: any) {
    v = { verified: false, reason: `verification error: ${e?.message ?? e}`, checked_at: now() };
  }
  return {
    pubkey: pk.toBase58(),
    rfq: r.rfq.toBase58(),
    quote: r.quote.toBase58(),
    buyer: rfq.buyer.toBase58(),
    seller: r.seller.toBase58(),
    price: quote.price.toString(),
    price_usdc: fmtUsdc(quote.price.toString()),
    payment_sig: sig,
    payment_ref_b58: bs58.encode(Buffer.from(r.paymentSig)),
    response_hash: hex(r.responseHash),
    reason_code: r.reasonCode,
    reason: reasonByCode(r.reasonCode),
    rejected_at: r.rejectedAt.toNumber(),
    ...(await recordExtras(pk, catalog)),
    // verified = the buyer really paid the seller (rejections are paid deliveries; no refund).
    verified: v.verified,
    verification: v,
  };
}

app.get(
  "/rejections",
  wrap(async (_req, res) => {
    const mint = await usdcMint();
    const all = await retry(() => prog.account.rejection.all(), "rejection.all");
    const uses = await paymentUseCounts();
    const out = (await Promise.all(all.map((r) => rejectionJson(r.publicKey, r.account, mint)))).map((r) => reuseGuard(r, uses));
    res.json(out.sort((a, b) => b.rejected_at - a.rejected_at));
  }),
);

// Per-seller track record from on-chain state only (sellers' off-chain declines are in log/*.jsonl).
app.get(
  "/sellers",
  wrap(async (_req, res) => {
    const rfqs = await retry(() => prog.account.rfq.all(), "rfq.all");
    const quotes = await retry(() => prog.account.quote.all(), "quote.all");
    const slas = await slaByQuote();
    const catalogs = await catalogByQuote();
    const rfqByPk = new Map(rfqs.map((r) => [r.publicKey.toBase58(), r.account]));
    const { recovered, withoutSettlement } = await fulfillmentKinds();
    const rows = new Map<string, any>();
    for (const q of quotes) {
      const seller = q.account.seller.toBase58();
      const cat = catalogs.get(q.publicKey.toBase58());
      // Catalog sellers are keyed by a per-host PDA, so one row per host.
      const row = rows.get(seller) ?? {
        seller, source: cat ? "catalog" : "seller", host: cat?.host ?? null, pay_to: [] as string[], quotes: 0, awarded: 0, fulfilled: 0, rejected: 0, rejected_by_reason: {} as Record<string, number>,
        sla_declared: 0, sla_measured: 0, sla_met: 0, endpoint_hosts: [] as string[], pay_networks: [] as string[], recovered: 0, delivered_without_settlement: 0,
      };
      row.quotes++;
      const payNet = cat?.network ?? X402_NETWORK();
      if (!row.pay_networks.includes(payNet)) row.pay_networks.push(payNet);
      if (cat && !row.pay_to.includes(cat.pay_to)) row.pay_to.push(cat.pay_to);
      // Hosts this seller quoted endpoints on (same key as x402 Seller Probe), so the
      // track record can be joined to Probe scores by host.
      const host = probeHost(q.account.endpointUri);
      if (host && !row.endpoint_hosts.includes(host)) row.endpoint_hosts.push(host);
      const r = rfqByPk.get(q.account.rfq.toBase58());
      if (r?.awardedQuote?.equals(q.publicKey)) {
        row.awarded++;
        // 送金なしで届いた is not a completed trade: counted apart, never as fulfilled.
        const k = q.account.rfq.toBase58();
        if (STATUS[r.status] === "fulfilled" && withoutSettlement.has(k)) row.delivered_without_settlement++;
        else if (STATUS[r.status] === "fulfilled") row.fulfilled++;
        if (STATUS[r.status] === "fulfilled" && recovered.has(k)) row.recovered++;
        if (STATUS[r.status] === "rejected") row.rejected++;
      }
      const sla = slas.get(q.publicKey.toBase58());
      if (sla) {
        row.sla_declared++;
        if (sla.measured_latency_ms !== null) row.sla_measured++;
        if (sla.met) row.sla_met++;
      }
      rows.set(seller, row);
    }
    const rejections = await retry(() => prog.account.rejection.all(), "rejection.all");
    for (const rj of rejections) {
      const row = rows.get(rj.account.seller.toBase58());
      if (row) {
        const k = reasonByCode(rj.account.reasonCode);
        row.rejected_by_reason[k] = (row.rejected_by_reason[k] ?? 0) + 1;
      }
    }
    res.json([...rows.values()]);
  }),
);

app.get(
  "/stats",
  wrap(async (_req, res) => {
    const rfqs = await retry(() => prog.account.rfq.all(), "rfq.all");
    const quotes = await retry(() => prog.account.quote.all(), "quote.all");
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
    const cfg = await retry(() => prog.account.config.fetchNullable(pda), "config.fetchNullable");
    const qByPk = new Map(quotes.map((q) => [q.publicKey.toBase58(), q.account]));
    const awarded = rfqs.filter((r) => r.account.awardedQuote);
    const awardedPrices = awarded.map((r) => BigInt(qByPk.get(r.account.awardedQuote!.toBase58())?.price.toString() ?? "0"));
    const sum = awardedPrices.reduce((s, p) => s + p, 0n);
    const feeBps = BigInt(cfg?.feeBps ?? 0);
    const fees = awardedPrices.reduce((s, p) => s + (p * feeBps) / 10_000n, 0n);
    const byStatus: Record<string, number> = {};
    for (const r of rfqs) byStatus[STATUS[r.account.status]] = (byStatus[STATUS[r.account.status]] ?? 0) + 1;
    const n = rfqs.length;
    const fulfilled = byStatus.fulfilled ?? 0;
    const rejected = byStatus.rejected ?? 0;
    const cancelled = byStatus.cancelled ?? 0;
    res.json({
      rfq_count: n,
      quote_count: quotes.length,
      // outcome columns over the same denominator (all RFQs, incl. aborted/cancelled)
      fulfilled,
      rejected,
      cancelled,
      open_or_awarded: n - fulfilled - rejected - cancelled,
      fulfilled_rate: n ? fulfilled / n : 0,
      rejected_rate: n ? rejected / n : 0,
      cancelled_rate: n ? cancelled / n : 0,
      by_status: byStatus,
      awarded_count: awarded.length,
      award_rate: n ? awarded.length / n : 0,
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
for (const ev of ["rfqPosted", "quoteSubmitted", "rfqAwarded", "rfqFulfilled", "rfqRejected", "slaDeclared", "latencyRecorded"] as const) {
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
