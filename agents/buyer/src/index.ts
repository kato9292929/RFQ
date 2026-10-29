// Buyer agent: posts an RFQ, collects quotes until the deadline, awards the
// cheapest (ties → earliest), pays the winner exactly once over x402, and
// records the fulfillment on-chain. Every step is appended to log/YYYY-MM-DD.jsonl.
// Records go to the RFQ program's cluster; a catalog seller is paid on the network its
// own 402 names (Solana mainnet USDC from MAINNET_BUYER_KEYPAIR, see lib/payment-net.ts).
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
  REASONS, appendLog, buyerSignatureFromPayload, connection, env, explorerTx, findLandedPayment, fmtUsdc, loadKeypair, pdas, program, retry, sha256, sleep,
  type Reason,
} from "../../../lib/common.js";
import { PROBE_URL, applyProbeFilter, checkMinProbeScore, lookupProbe, probeNoPayReason, type ProbeLookup } from "../../../lib/probe.js";
import {
  OWN_HOSTS, catalogSpentToday, fetch402, hostOf, loadCatalog, loadPathOverrides, maxPerCall, maxPerDay, payHosts, pickAccept, retryAllowed, selectCatalogUrls,
  type CatalogMatch,
} from "../../../lib/catalog.js";
import {
  encodePaymentRef, fillBaseEip712, explorerFor, isEvm, loadPayers, memoInstruction, type Payer, type RecordMemo,
} from "../../../lib/payment-net.js";
import { evmAuthorizationNonce, evmScheme, evmUsdcBalance, findLandedEvm } from "../../../lib/evm-pay.js";
import { checkReceipt, readReceipt } from "../../../lib/receipt.js";

const { BN } = anchor;

const kp = loadKeypair(env("BUYER_KEYPAIR"));
const MAX_PRICE = BigInt(env("BUYER_MAX_PRICE", "100000")); // 0.10 USDC
const WINDOW = Number(env("BUYER_RFQ_WINDOW_SEC", "90"));
let specText = process.env.BUYER_SPEC_FILE
  ? readFileSync(resolve(ROOT, process.env.BUYER_SPEC_FILE), "utf8")
  : JSON.stringify({ category: "market-data", fields: ["endpoint_count", "host_count"], freshness_hours: 24 });

// Fail before posting anything if the optional Probe threshold is malformed.
const MIN_PROBE_SCORE = checkMinProbeScore(JSON.parse(specText).min_probe_score);

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

// Payers by network (records stay on this cluster).
const cfg = await prog.account.config.fetch(P.config());
const { payers, notes: payerNotes } = await loadPayers(kp, cfg.usdcMint);
for (const n of payerNotes) log(n);
// A catalog RFQ commits, in its spec (hashed on-chain), which address pays on which network,
// so the indexer can check the payment's sender without trusting the buyer later.
if (JSON.parse(specText).catalog_match) {
  specText = JSON.stringify({ ...JSON.parse(specText), payers: Object.fromEntries([...payers].map(([n, p]) => [n, p.address])) });
}

// 1. spec → indexer
const { spec_hash, spec_uri } = await json<{ spec_hash: string; spec_uri: string }>(`${INDEXER_URL()}/specs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: specText,
});
log(`spec stored hash=${spec_hash}`);

// 2. post_rfq
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

// 2b. catalog quotes: read each catalog endpoint's own 402 and record its price as a quote.
const catalogMatch = (JSON.parse(specText) as { catalog_match?: CatalogMatch }).catalog_match;
if (catalogMatch) {
  const catalog = loadCatalog();
  const urls = selectCatalogUrls(catalog.endpoints, catalogMatch, loadPathOverrides());
  const cap = (() => {
    const perCall = maxPerCall();
    const usd = catalogMatch.max_price_usdc !== undefined ? BigInt(Math.round(catalogMatch.max_price_usdc * 1e6)) : perCall;
    return [perCall, usd, MAX_PRICE].reduce((m, x) => (x < m ? x : m));
  })();
  log(`catalog: ${urls.length} endpoint(s) from ${catalogMatch.urls?.length ? "the spec's urls" : catalog.source} (cap ${fmtUsdc(cap)} USDC per call)`);
  type Best = { url: string; amount: bigint; payTo: string; network: string; payable: boolean; probe: ProbeLookup };
  const best = new Map<string, Best>();
  for (const url of urls) {
    const host = hostOf(url)!;
    const probe = await lookupProbe(url);
    const r = await fetch402(url);
    const picked = r.ok ? pickAccept(r.accepts, [...payers.keys()], cap) : r;
    record("catalog_402", {
      rfq: rfq.toBase58(), url, host, ok: picked.ok, probe,
      ...(picked.ok ? { amount: picked.amount.toString(), pay_to: picked.payTo, network: picked.network, payable: picked.payable } : { reason: picked.reason }),
      ...(r.ok ? { accepts: r.accepts } : {}),
    });
    if (!picked.ok) {
      log(`catalog skip ${url}: ${picked.reason}`);
      continue;
    }
    // one catalog quote per host per RFQ (the quote PDA is per host): payable first, then cheapest
    const cur = best.get(host);
    if (!cur || (picked.payable && !cur.payable) || (picked.payable === cur.payable && picked.amount < cur.amount))
      best.set(host, { url, amount: picked.amount, payTo: picked.payTo, network: picked.network, payable: picked.payable, probe });
  }
  for (const [host, b] of best) {
    const hostHash = sha256(host);
    const sig = await prog.methods
      .submitCatalogQuote(host, [...hostHash], new BN(b.amount.toString()), [...sha256(b.url)], b.url, new BN(deadline + 1800), b.payTo, b.network)
      .accountsPartial({ buyer: me, rfq, catalogSeller: P.catalogSeller(host) })
      .rpc();
    log(`catalog quote ${host} ${fmtUsdc(b.amount)} USDC on ${b.network}${b.payable ? "" : " (not payable here)"} (${b.url}) tx=${sig}`);
    record("catalog_quote", {
      rfq: rfq.toBase58(), host, url: b.url, price: b.amount.toString(), price_usdc: fmtUsdc(b.amount), pay_to: b.payTo, network: b.network,
      payable: b.payable, probe_score: b.probe.status === "scored" ? b.probe.score : null, probe_status: b.probe.status,
      probe_verdict: b.probe.status === "scored" ? b.probe.verdict : null,
      probe_requires_input: b.probe.status === "scored" ? b.probe.requires_input : null,
      seller: P.catalogSeller(host).toBase58(), quote: P.quote(rfq, P.catalogSeller(host)).toBase58(), tx: sig, explorer: explorerTx(sig),
    });
  }
}

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
  category: string; fields?: string[]; freshness_hours?: number; max_latency_ms?: number; schema?: object; min_probe_score?: number;
};
// Who may be paid: our own hosts + hosts whose latest Seller Probe paid verdict is 納品 (delivered)
// and that need no input. Others are recorded as quotes only, with the reason. A host the Probe
// did not answer for is not added, so with the Probe down only our own hosts are paid.
const probeDelivered: string[] = [];
const probeNoPay: Record<string, string> = {};
for (const q of detail.quotes as any[]) {
  if (q.source !== "catalog" || OWN_HOSTS.includes(q.catalog.host)) continue;
  const why = probeNoPayReason(await lookupProbe(q.endpoint_uri));
  if (why) probeNoPay[q.catalog.host] = why;
  else if (!probeDelivered.includes(q.catalog.host)) probeDelivered.push(q.catalog.host);
}
const allowedPayHosts = payHosts(probeDelivered);
record("catalog_pay_hosts", { rfq: rfq.toBase58(), pay_hosts: allowedPayHosts, probe_delivered: probeDelivered, probe_no_pay: probeNoPay });
// Catalog payment limits, enforced here and again right before signing.
const spentToday = catalogSpentToday();
const nowS = Math.floor(Date.now() / 1000);
const excluded: { quote: string; seller: string; why: string }[] = [];
let eligible = (detail.quotes as any[]).filter((q) => {
  const why =
    q.expires_at <= nowS + 30 ? "quote expires too soon"
    : !q.endpoint_hash_ok ? "endpoint_hash does not match endpoint_uri"
    : BigInt(q.price) > MAX_PRICE ? "price above max_price"
    : spec.max_latency_ms !== undefined && !q.sla ? `no SLA declared (spec max_latency_ms=${spec.max_latency_ms})`
    : spec.max_latency_ms !== undefined && q.sla.max_latency_ms > spec.max_latency_ms
      ? `SLA ${q.sla.max_latency_ms}ms > spec max_latency_ms=${spec.max_latency_ms}`
    : q.source === "catalog" && !payers.has(q.catalog?.network)
      ? `catalog quote on ${q.catalog?.network}: this buyer does not pay on that network (recorded only)`
    : q.source === "catalog" && !allowedPayHosts.includes(q.catalog?.host)
      ? `catalog host ${q.catalog?.host} not paid: ${probeNoPay[q.catalog?.host] ?? "not ours and not delivered in Seller Probe"} (recorded only)`
    : q.source === "catalog" && BigInt(q.price) > maxPerCall() ? `catalog price above per-call cap ${fmtUsdc(maxPerCall())}`
    : q.source === "catalog" && spentToday + BigInt(q.price) > maxPerDay()
      ? `catalog daily cap: spent ${fmtUsdc(spentToday)} + ${q.price_usdc} > ${fmtUsdc(maxPerDay())}`
    : "";
  if (why) excluded.push({ quote: q.pubkey, seller: q.seller, why });
  return !why;
});

// Seller quality gate (x402 Seller Probe). Applied after the price/SLA checks, before the tie-break.
let probeFilter: Record<string, unknown> | null = null;
if (MIN_PROBE_SCORE !== undefined && eligible.length) {
  const lookups = new Map<string, ProbeLookup>(await Promise.all(eligible.map(async (q) => [q.pubkey, await lookupProbe(q.endpoint_uri)] as const)));
  const r = applyProbeFilter(eligible, lookups, MIN_PROBE_SCORE);
  eligible = r.kept;
  excluded.push(...r.excluded);
  probeFilter = {
    probe_url: PROBE_URL(), min_probe_score: MIN_PROBE_SCORE,
    lookups: [...lookups].map(([quote, l]) => ({ quote, ...l })),
    excluded: r.excluded,
    probe_unscored: r.unscored,
    probe_unavailable: r.unavailable,
  };
  record("probe_filter", { rfq: rfq.toBase58(), ...probeFilter });
  if (r.unscored.length) log(`probe_unscored for ${r.unscored.length} quote(s) — kept (no score is not below the minimum)`);
  if (r.unavailable.length) log(`probe_unavailable for ${r.unavailable.length} quote(s) — kept, selection proceeds as before`);
  if (r.excluded.length) log(`probe excluded: ${r.excluded.map((e) => `${e.seller.slice(0, 6)} (${e.why})`).join(", ")}`);
}

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
    sla_ms: q.sla?.max_latency_ms ?? null, source: q.source, catalog: q.catalog ?? null,
  })),
  excluded,
  tie_break: tieBreak,
  probe_filter: probeFilter,
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
const isCatalog = win.source === "catalog";
// Catalog sellers are paid at the address and network their own 402 advertised.
const payTo: string = isCatalog ? win.catalog.pay_to : win.seller;
const network = (isCatalog ? win.catalog.network : X402_NETWORK()) as `${string}:${string}`;
const payer = payers.get(network);
if (!payer) throw new Error(`no payer for ${network}`);
const payMint = payer.kind === "svm" ? payer.usdcMint.toBase58() : payer.usdc;
const schemeClient = payer.kind === "svm"
  ? new ExactSvmScheme(await createKeyPairSignerFromBytes(payer.keypair.secretKey), { rpcUrl: payer.rpcUrl })
  : evmScheme(payer);
const same = (a: string, b: string) => (isEvm(network) ? a?.toLowerCase() === b?.toLowerCase() : a === b);
const client = x402Client.fromConfig({
  schemes: [{ network, client: schemeClient }],
  spendControls: { allowedAssets: [{ network, asset: payMint, maxAmountPerPayment: win.price }] },
  // Only pay the awarded seller, the awarded price, in that network's USDC.
  policies: [
    (_v, reqs) =>
      reqs.filter((r: any) => same(r.payTo, payTo) && r.amount === win.price && same(r.asset, payMint) && r.scheme === "exact" && r.network === network),
  ],
});
const http = new x402HTTPClient(client);
const host = hostOf(win.endpoint_uri) ?? "";

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
// Base USDC: a 402 that omits the EIP-712 name/version gets Circle USDC's known values, but only
// when the asset IS Circle USDC on Base (same as Seller Probe). Any other asset is not paid.
for (const filled of fillBaseEip712(required.accepts as any[])) record("eip712_filled", { rfq: rfq.toBase58(), ...filled });
const req0 = required.accepts[0];
log(`402 received: ${req0.scheme} ${req0.network} amount=${req0.amount} asset=${req0.asset} payTo=${req0.payTo}`);
record("x402_payment_required", { rfq: rfq.toBase58(), endpoint_uri: win.endpoint_uri, accepts: required.accepts });

if (isCatalog) {
  // Hard stop right before signing: per-call and per-day caps for catalog sellers.
  const spent = catalogSpentToday();
  if (BigInt(win.price) > maxPerCall() || spent + BigInt(win.price) > maxPerDay()) {
    record("catalog_cap_refused", { rfq: rfq.toBase58(), price: win.price, spent_today: spent.toString(), max_per_call: maxPerCall().toString(), max_per_day: maxPerDay().toString() });
    throw new Error(`catalog cap: price ${win.price}, spent today ${spent} (per call ${maxPerCall()}, per day ${maxPerDay()})`);
  }
}
const payload = await http.createPaymentPayload(required);
const paymentHeaders = http.encodePaymentSignatureHeader(payload);
// Write the payment's identity before sending: the payer's own signature in the Solana tx, or the
// EIP-3009 nonce on Base. It is the key for finding the transfer later if the data does not arrive.
const buyerPaymentSig = payer.kind === "svm" ? buyerSignatureFromPayload(payload, payer.keypair.publicKey) : evmAuthorizationNonce(payload);
record("x402_payment_sent", {
  rfq: rfq.toBase58(), seller: win.seller, pay_to: payTo, network, payer: payer.address, amount: win.price,
  source: win.source ?? "seller", host: win.catalog?.host ?? null, buyer_signature: buyerPaymentSig,
});
const memoBase: RecordMemo = { pay_net: network, payer: payer.address };
const payExplorer = (sig: string) => explorerFor(network, sig);

/** The landed payment carrying our signature / authorization, if any. */
async function findLanded(p: Payer): Promise<{ tx: string; ok: boolean } | null> {
  if (p.kind === "evm") {
    const l = await findLandedEvm(p, buyerPaymentSig as `0x${string}`);
    return l ? { tx: l.hash, ok: l.ok } : null;
  }
  const l = await findLandedPayment(p.conn, getAssociatedTokenAddressSync(p.usdcMint, p.keypair.publicKey), buyerPaymentSig);
  return l ? { tx: l.signature, ok: !l.err } : null;
}
async function usdcBalance(p: Payer): Promise<bigint> {
  return p.kind === "evm" ? evmUsdcBalance(p) : (await getAccount(p.conn, getAssociatedTokenAddressSync(p.usdcMint, p.keypair.publicKey))).amount;
}
// Measured latency = the paid call end to end (request → settled response body), which
// is what the seller's declared SLA covers.
const t0 = performance.now();
const paid = await fetch(win.endpoint_uri, { headers: paymentHeaders });
let bodyBytes = Buffer.from(await paid.arrayBuffer());
const latencyMs = Math.round(performance.now() - t0);
let paymentTx: string | null;
let deliveredHeaders: Headers = paid.headers;
let recovered: { first_status: number } | null = null;

async function waitVerified(endpoint: "fulfillments" | "rejections"): Promise<any> {
  let v: any;
  for (let i = 0; i < 10; i++) {
    v = (await json<any[]>(`${INDEXER_URL()}/${endpoint}`).catch(() => [] as any[])).find((f) => f.rfq === rfq.toBase58());
    if (v?.verified) break;
    await sleep(3000);
  }
  return v;
}

if (paid.status !== 200) {
  // The seller withheld the data. With x402 exact-SVM the facilitator may still land
  // the transfer after the seller's /settle wait expired, so check the chain for the
  // tx carrying our signature before concluding we did not pay.
  log(`paid request returned ${paid.status}; looking for the payment tx with buyer signature ${buyerPaymentSig.slice(0, 12)}… on ${network}`);
  const landed = await findLanded(payer);
  record("x402_paid_request_failed", {
    rfq: rfq.toBase58(), seller: win.seller, http_status: paid.status, body: bodyBytes.toString("utf8").slice(0, 400),
    latency_ms: latencyMs, network, buyer_signature: buyerPaymentSig, landed_payment_tx: landed?.tx ?? null, landed_ok: landed?.ok ?? null,
  });
  if (!landed || !landed.ok) {
    log("no landed payment found — nothing paid, nothing delivered; RFQ stays awarded");
    process.exit(1);
  }
  // Paid, not delivered. Our own sellers and local test sellers may be asked once more with
  // the SAME payment header (a receipt-issuing seller answers it without charging again).
  // Third-party sellers are never re-sent a payment header.
  let retry: RecordMemo["retry"] = "not_allowed";
  if (retryAllowed(host)) {
    const t1 = performance.now();
    const again = await fetch(win.endpoint_uri, { headers: paymentHeaders });
    const againBody = Buffer.from(await again.arrayBuffer());
    record("x402_rerequest", {
      rfq: rfq.toBase58(), host, http_status: again.status, latency_ms: Math.round(performance.now() - t1), payment_tx: landed.tx,
      replay_header: again.headers.get("delivery-replay"), body_preview: againBody.toString("utf8").slice(0, 200),
    });
    if (again.status === 200) {
      log(`re-request with the same payment header delivered (${againBody.length} bytes) — recovering the not_delivered payment`);
      bodyBytes = againBody;
      deliveredHeaders = again.headers;
      recovered = { first_status: paid.status };
    } else retry = "failed";
  }
  if (!recovered) {
    const respHash = sha256(bodyBytes);
    const quotePk0 = new PublicKey(win.pubkey);
    const rejSig = await prog.methods
      .recordRejection(encodePaymentRef(network, landed.tx), [...respHash], REASONS.not_delivered.code)
      .accountsPartial({ buyer: me, rfq, quote: quotePk0 })
      .postInstructions([memoInstruction({ ...memoBase, retry, first_status: paid.status })])
      .rpc();
    log(`paid but not delivered: payment tx=${landed.tx} (re-request: ${retry}) → record_rejection(not_delivered) tx=${rejSig}`);
    record("record_rejection", {
      rfq: rfq.toBase58(), rejection: P.rejection(rfq).toBase58(), seller: win.seller, payment_tx: landed.tx, payment_network: network,
      payment_explorer: payExplorer(landed.tx), response_sha256: respHash.toString("hex"), reason: "not_delivered", reason_code: REASONS.not_delivered.code,
      detail: { http_status: paid.status, matched_by: "buyer signature in payment tx", buyer_signature: buyerPaymentSig, rerequest: retry },
      tx: rejSig, explorer: explorerTx(rejSig),
    });
    const v = await waitVerified("rejections");
    record("indexer_verification", { rfq: rfq.toBase58(), outcome: "rejected", reason: "not_delivered", verified: v?.verified ?? false, verification: v?.verification });
    log(`outcome=rejected(not_delivered) payment verified=${v?.verified}`);
    process.exit(v?.verified ? 3 : 1);
  }
  paymentTx = landed.tx;
} else {
  let settle: any = null;
  try {
    settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
  } catch {
    /* no or unreadable settlement header */
  }
  if (settle?.success && settle.transaction) paymentTx = settle.transaction;
  else {
    // 200 without a settlement header: look on chain before deciding nothing was paid.
    log(`200 without a settlement result; looking for the payment on ${network}`);
    const landed = await findLanded(payer);
    record("x402_settlement_missing", { rfq: rfq.toBase58(), host, settle, landed_payment_tx: landed?.tx ?? null, landed_ok: landed?.ok ?? null });
    paymentTx = landed?.ok ? landed.tx : null;
  }
}
// 送金なしで届いた: the data came but no payment landed. Kept apart from fulfilled.
const withoutSettlement = paymentTx === null;
const responseHash = sha256(bodyBytes);
log(withoutSettlement
  ? `delivered WITHOUT a settled payment on ${network} response_sha256=${responseHash.toString("hex")}`
  : `paid ${fmtUsdc(win.price)} USDC on ${network} tx=${paymentTx} response_sha256=${responseHash.toString("hex")}`);
record(withoutSettlement ? "x402_delivered_without_settlement" : "x402_paid", {
  rfq: rfq.toBase58(), seller: win.seller, amount: win.price, amount_usdc: win.price_usdc, network,
  payment_tx: paymentTx, explorer: paymentTx ? payExplorer(paymentTx) : null, payer: payer.address,
  response_sha256: responseHash.toString("hex"), response_bytes: bodyBytes.length, latency_ms: latencyMs, recovered: !!recovered,
  response_preview: bodyBytes.toString("utf8").slice(0, 400),
});

// Delivery Receipt (if the seller sent one): body hash + signature + it names our payment.
const receipt = checkReceipt(readReceipt((n) => deliveredHeaders.get(n)), { body: bodyBytes, payment_id: paymentTx ?? "", network, pay_to: payTo });
record("delivery_receipt", { rfq: rfq.toBase58(), host, ...receipt });
if (receipt.present) log(`delivery receipt: ${receipt.ok ? "verified" : `INVALID (${receipt.problems.join("; ")})`} signer=${receipt.signer}`);

// Optional (BUYER_CONFIRM_REREQUEST=1, our own hosts only): send the same payment header once
// more and confirm the seller returns the same body without charging again.
if (process.env.BUYER_CONFIRM_REREQUEST === "1" && !recovered && !withoutSettlement) {
  if (!retryAllowed(host)) record("rerequest_check", { rfq: rfq.toBase58(), host, done: false, why: "not our host: never re-send a payment header to a third party" });
  else if (!receipt.present) record("rerequest_check", { rfq: rfq.toBase58(), host, done: false, why: "seller sent no Delivery Receipt (no re-request support)" });
  else {
    const before = await usdcBalance(payer);
    const again = await fetch(win.endpoint_uri, { headers: paymentHeaders });
    const againBody = Buffer.from(await again.arrayBuffer());
    await sleep(15_000);
    const after = await usdcBalance(payer);
    const same = again.status === 200 && sha256(againBody).equals(responseHash);
    record("rerequest_check", {
      rfq: rfq.toBase58(), host, done: true, http_status: again.status, same_body: same, balance_before: before.toString(), balance_after: after.toString(),
      charged_again: after !== before, replay_header: again.headers.get("delivery-replay"),
    });
    log(`re-request check: status=${again.status} same_body=${same} charged_again=${after !== before}`);
  }
}

// 6. acceptance test → record_fulfillment or record_rejection
function accept(): { ok: true } | { ok: false; reason: Reason; detail: unknown } {
  let body: any;
  try {
    body = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_response", detail: "body is not JSON" };
  }
  // Our sellers wrap the payload as {data, source}; a catalog seller's body is the data itself,
  // with no common freshness field, so freshness_hours applies to our sellers only.
  const data = isCatalog ? body : body?.data;
  if (!data || typeof data !== "object") return { ok: false, reason: "invalid_response", detail: "no data object" };
  const missing = (spec.fields ?? []).filter((f) => data[f] === undefined || data[f] === null);
  if (missing.length) return { ok: false, reason: "missing_fields", detail: { missing } };
  if (spec.freshness_hours !== undefined && !isCatalog) {
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
const sigBytes = encodePaymentRef(network, paymentTx); // all zeros when no payment landed
const quotePk = new PublicKey(win.pubkey);
const memo = memoInstruction({
  ...memoBase,
  receipt: !receipt.present ? "none" : receipt.ok ? "ok" : "bad",
  ...(receipt.signer ? { receipt_signer: receipt.signer } : {}),
  ...(recovered ? { recovered: true, first_status: recovered.first_status } : {}),
  ...(withoutSettlement ? { outcome: "delivered_without_settlement" as const } : {}),
});

if (verdict.ok) {
  const fulfilSig = await prog.methods
    .recordFulfillment([...sigBytes], [...responseHash])
    .accountsPartial({ buyer: me, rfq, quote: quotePk })
    .postInstructions([memo])
    .rpc();
  log(`record_fulfillment tx=${fulfilSig}${recovered ? " (recovered by re-request)" : ""}`);
  record("record_fulfillment", {
    rfq: rfq.toBase58(), fulfillment: P.fulfillment(rfq).toBase58(), payment_tx: paymentTx, payment_network: network,
    payment_explorer: paymentTx ? payExplorer(paymentTx) : null, outcome: withoutSettlement ? "delivered_without_settlement" : recovered ? "recovered" : "fulfilled",
    response_sha256: responseHash.toString("hex"), recovered: !!recovered, receipt: receipt.present ? (receipt.ok ? "ok" : "bad") : "none",
    tx: fulfilSig, explorer: explorerTx(fulfilSig),
  });
} else {
  const code = REASONS[verdict.reason].code;
  const rejSig = await prog.methods
    .recordRejection([...sigBytes], [...responseHash], code)
    .accountsPartial({ buyer: me, rfq, quote: quotePk })
    .postInstructions([memo])
    .rpc();
  log(`record_rejection reason=${verdict.reason}(${code}) tx=${rejSig} — paid, no refund (no escrow)`);
  record("record_rejection", {
    rfq: rfq.toBase58(), rejection: P.rejection(rfq).toBase58(), seller: win.seller, payment_tx: paymentTx, payment_network: network,
    payment_explorer: paymentTx ? payExplorer(paymentTx) : null, response_sha256: responseHash.toString("hex"), reason: verdict.reason, reason_code: code, detail: verdict.detail,
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

// 8. ask the indexer to verify the payment against the chain it happened on
const mine = await waitVerified(verdict.ok ? "fulfillments" : "rejections");
record("indexer_verification", {
  rfq: rfq.toBase58(), outcome: verdict.ok ? (withoutSettlement ? "delivered_without_settlement" : recovered ? "recovered" : "fulfilled") : "rejected", verified: mine?.verified ?? false, verification: mine?.verification,
});
console.log(JSON.stringify(mine, null, 2));
log(`outcome=${verdict.ok ? (recovered ? "fulfilled (recovered by re-request)" : "fulfilled") : "rejected"} payment verified=${mine?.verified}`);
// exit: 0 fulfilled+verified, 3 rejected (payment verified), 4 delivered without settlement, 1 anything unverified
if (withoutSettlement) process.exit(4);
process.exit(!mine?.verified ? 1 : verdict.ok ? 0 : 3);
