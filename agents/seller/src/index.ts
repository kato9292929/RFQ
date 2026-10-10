// Seller agent: polls open RFQs, quotes the ones it can serve, and serves the
// awarded data behind an x402 (exact, SVM, USDC) per-call paywall.
import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import {
  FACILITATOR_URL, INDEXER_URL, ROOT, RPC_URL, X402_NETWORK,
  appendLog, connection, env, explorerTx, fmtUsdc, loadKeypair, pdas, program, sha256, sleep,
} from "../../../lib/common.js";

const { BN } = anchor;

type Offer = { id: string; category: string; fields: string[]; list_price: number; description: string };
type Spec = { category: string; fields?: string[]; freshness_hours?: number };
type Deal = { rfq: string; offer: Offer; spec: Spec; price: bigint; quote: string };

const kp = loadKeypair(env("SELLER_KEYPAIR"));
const offersFile = JSON.parse(readFileSync(resolve(ROOT, env("SELLER_OFFERS")), "utf8")) as { name: string; offers: Offer[] };
const NAME = env("SELLER_NAME", offersFile.name);
const PORT = Number(env("SELLER_PORT", "8801"));
const PUBLIC_URL = env("SELLER_PUBLIC_URL", `http://127.0.0.1:${PORT}`);
const POLL_MS = Number(env("SELLER_POLL_MS", "60000"));
const QUOTE_TTL = Number(env("SELLER_QUOTE_TTL_SEC", "1800"));
const snapshotPath = resolve(ROOT, env("SELLER_CATALOG", "agents/seller/data/catalog-snapshot.json"));

const prog = program(kp);
const P = pdas(prog.programId);
const conn = connection();
const me = kp.publicKey;
const log = (...a: unknown[]) => console.log(`[${NAME}]`, ...a);

const deals = new Map<string, Deal>(); // rfq pubkey → what we quoted
const declined = new Set<string>(); // rfqs we decided not to quote (logged once)
let usdcMint: PublicKey;

function snapshot(): Record<string, any> {
  return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

function matchOffer(spec: Spec): { offer?: Offer; reason: string } {
  const offer = offersFile.offers.find(
    (o) => o.category === spec.category && (spec.fields ?? []).every((f) => o.fields.includes(f)),
  );
  if (!offer) return { reason: `no offer for category=${spec.category} fields=${(spec.fields ?? []).join(",")}` };
  if (spec.freshness_hours !== undefined) {
    const ageH = (Date.now() - Date.parse(snapshot().source.generated_at)) / 3_600_000;
    if (ageH > spec.freshness_hours) return { reason: `snapshot is ${ageH.toFixed(1)}h old > freshness_hours=${spec.freshness_hours}` };
  }
  return { offer, reason: "match" };
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return (await r.json()) as T;
}

async function fetchSpec(specUri: string, specHashHex: string): Promise<Spec> {
  const r = await fetch(specUri);
  if (!r.ok) throw new Error(`spec ${specUri} → ${r.status}`);
  const body = Buffer.from(await r.arrayBuffer());
  if (sha256(body).toString("hex") !== specHashHex) throw new Error("spec body does not match on-chain spec_hash");
  return JSON.parse(body.toString("utf8"));
}

async function pollOnce() {
  const rfqs = await getJson<any[]>(`${INDEXER_URL()}/rfqs?status=open`);
  for (const r of rfqs) {
    if (r.buyer === me.toBase58()) continue;
    const rfq = new PublicKey(r.pubkey);
    const quotePda = P.quote(rfq, me);
    if (deals.has(r.pubkey) || declined.has(r.pubkey) || (await conn.getAccountInfo(quotePda))) continue;
    let spec: Spec;
    try {
      spec = await fetchSpec(r.spec_uri, r.spec_hash);
    } catch (e: any) {
      log(`skip ${r.pubkey}: ${e.message}`);
      continue;
    }
    const { offer, reason } = matchOffer(spec);
    if (!offer) {
      if (!declined.has(r.pubkey)) {
        declined.add(r.pubkey);
        log(`decline ${r.pubkey}: ${reason}`);
        appendLog({ actor: NAME, step: "decline", rfq: r.pubkey, seller: me.toBase58(), reason, spec });
      }
      continue;
    }
    const maxPrice = BigInt(r.max_price);
    const price = BigInt(offer.list_price) < maxPrice ? BigInt(offer.list_price) : maxPrice;
    const endpointUri = `${PUBLIC_URL}/q/${r.pubkey}`;
    const expiresAt = Math.floor(Date.now() / 1000) + QUOTE_TTL;
    try {
      const sig = await prog.methods
        .submitQuote(new BN(price.toString()), [...sha256(endpointUri)], endpointUri, new BN(expiresAt))
        .accountsPartial({ seller: me, rfq })
        .rpc();
      deals.set(r.pubkey, { rfq: r.pubkey, offer, spec, price, quote: quotePda.toBase58() });
      log(`quoted ${r.pubkey} offer=${offer.id} price=${fmtUsdc(price)} USDC tx=${sig}`);
      appendLog({
        actor: NAME, step: "submit_quote", rfq: r.pubkey, quote: quotePda.toBase58(), seller: me.toBase58(),
        offer: offer.id, price: price.toString(), price_usdc: fmtUsdc(price), endpoint_uri: endpointUri,
        expires_at: expiresAt, tx: sig, explorer: explorerTx(sig),
      });
    } catch (e: any) {
      log(`submit_quote failed for ${r.pubkey}: ${e.message}`);
    }
  }
}

/** Rebuild a deal from chain state (e.g. after restart). */
async function loadDeal(rfqKey: string): Promise<Deal | undefined> {
  const cached = deals.get(rfqKey);
  if (cached) return cached;
  const d = await getJson<any>(`${INDEXER_URL()}/rfqs/${rfqKey}`).catch(() => undefined);
  const q = d?.quotes?.find((x: any) => x.seller === me.toBase58());
  if (!q) return undefined;
  const spec = await fetchSpec(d.spec_uri, d.spec_hash);
  const { offer } = matchOffer(spec);
  if (!offer) return undefined;
  const deal = { rfq: rfqKey, offer, spec, price: BigInt(q.price), quote: q.pubkey };
  deals.set(rfqKey, deal);
  return deal;
}

// ---- x402 endpoint ------------------------------------------------------------

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, seller: me.toBase58(), name: NAME, offers: offersFile.offers.map((o) => o.id) });
});

// Only the awarded seller's quote is payable: refuse before the 402 is issued otherwise.
app.use("/q/:rfq", async (req, res, next) => {
  try {
    const rfqKey = new PublicKey(req.params.rfq);
    const deal = await loadDeal(rfqKey.toBase58());
    if (!deal) return res.status(404).json({ error: "no quote from this seller for this RFQ" });
    const rfq = await prog.account.rfq.fetch(rfqKey);
    if (rfq.awardedQuote?.toBase58() !== deal.quote) return res.status(409).json({ error: "RFQ not awarded to this seller" });
    (req as any).deal = deal;
    next();
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL() });
const network = X402_NETWORK() as `${string}:${string}`;
const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactSvmScheme({ rpcUrl: RPC_URL() }));

app.use(
  paymentMiddleware(
    {
      "GET /q/*": {
        accepts: {
          scheme: "exact",
          network,
          payTo: me.toBase58(),
          // Price is exactly the on-chain quote.price, in the configured USDC mint's base units.
          price: async (ctx) => {
            const rfqKey = ctx.path.split("/").filter(Boolean)[1];
            const deal = await loadDeal(rfqKey);
            if (!deal) throw new Error("unknown rfq");
            return { asset: usdcMint.toBase58(), amount: deal.price.toString(), extra: { name: "USDC", decimals: 6 } };
          },
          maxTimeoutSeconds: 120,
        },
        description: "RFQ market: awarded data delivery",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/q/:rfq", (req, res) => {
  const deal: Deal = (req as any).deal;
  const snap = snapshot();
  const fields = deal.spec.fields?.length ? deal.spec.fields : deal.offer.fields;
  const data = Object.fromEntries(fields.map((f) => [f, snap[f] ?? null]));
  res.json({
    rfq: deal.rfq,
    seller: me.toBase58(),
    offer: deal.offer.id,
    data,
    source: snap.source,
  });
  appendLog({ actor: NAME, step: "served", rfq: deal.rfq, quote: deal.quote, price: deal.price.toString(), offer: deal.offer.id });
});

// ---- boot ---------------------------------------------------------------------

const cfg = await prog.account.config.fetch(P.config());
usdcMint = cfg.usdcMint;
const ata = await getOrCreateAssociatedTokenAccount(conn, kp, usdcMint, me);
log(`seller=${me.toBase58()} usdc_ata=${ata.address.toBase58()} mint=${usdcMint.toBase58()} facilitator=${FACILITATOR_URL()}`);

app.listen(PORT, () => log(`x402 endpoint on ${PUBLIC_URL}/q/:rfq`));

for (;;) {
  try {
    await pollOnce();
  } catch (e: any) {
    log(`poll error: ${e.message}`);
  }
  await sleep(POLL_MS);
}
