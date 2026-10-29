// Catalog quotes: turn x402 Endpoint catalog entries into quotes by reading each
// endpoint's own 402 price. Sellers implement nothing; the buyer records the quote.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ROOT } from "./common.js";
import { BASE_MAINNET_CAIP2, SOLANA_MAINNET_CAIP2, USDC_BY_NETWORK } from "./payment-net.js";

export type CatalogEntry = { url: string; category?: string; networks?: string[]; price?: { amount?: number } | null };
export type CatalogMatch = {
  categories?: string[];
  networks?: string[]; // catalog chain names, e.g. "Solana"
  max_price_usdc?: number;
  hosts?: string[];
  urls?: string[]; // ask exactly these URLs (e.g. the path the Probe paid for), skipping the catalog lookup
};

/** Hard caps for paying catalog sellers. Env can lower them, never raise them. */
export const HARD_MAX_PER_CALL = 10_000n; // $0.01 (USDC, 6 decimals)
export const HARD_MAX_PER_DAY = 500_000n; // $0.50
const lowerOnly = (name: string, hard: bigint) => {
  const v = process.env[name];
  if (!v) return hard;
  const n = BigInt(v);
  return n < hard ? n : hard;
};
export const maxPerCall = () => lowerOnly("CATALOG_MAX_PER_CALL", HARD_MAX_PER_CALL);
export const maxPerDay = () => lowerOnly("CATALOG_MAX_PER_DAY", HARD_MAX_PER_DAY);
export const MAX_CATALOG_ENDPOINTS = 5;

/** Our own sellers (OSD, JIN). CATALOG_PAY_HOSTS replaces this base list (tests use 127.0.0.1). */
export const OWN_HOSTS = ["osd.x402jp.com", "jin.x402jp.com"];
const baseHosts = () =>
  (process.env.CATALOG_PAY_HOSTS ?? OWN_HOSTS.join(","))
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/**
 * Hosts the buyer may pay through catalog quotes: the base list (our own) plus hosts whose
 * latest paid measurement by x402 Seller Probe was `delivered`. Pass null when the Probe did
 * not answer: then only the base list.
 */
export function payHosts(probeDelivered: string[] | null = null): string[] {
  return [...new Set([...baseHosts(), ...(probeDelivered ?? [])])];
}

/**
 * Hosts a not_delivered payment may be re-requested from with the same payment header:
 * our own sellers and local test sellers only. Never a third party.
 */
export function retryAllowed(host: string): boolean {
  return [...OWN_HOSTS, "127.0.0.1", "localhost"].includes(host.toLowerCase());
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Read the catalog: CATALOG_FILE (JSON {endpoints}) or the x402 Endpoint snapshot in a read-only clone. */
export function loadCatalog(): { source: string; endpoints: CatalogEntry[] } {
  if (process.env.CATALOG_FILE) {
    const p = resolve(ROOT, process.env.CATALOG_FILE);
    return { source: p, endpoints: JSON.parse(readFileSync(p, "utf8")).endpoints };
  }
  const dir = resolve(ROOT, process.env.ENDPOINT_REPO_DIR ?? "run/endpoint-ro", "data");
  const full = resolve(dir, "endpoints_full.json.gz");
  if (existsSync(full)) return { source: full, endpoints: JSON.parse(gunzipSync(readFileSync(full)).toString("utf8")).endpoints };
  const subset = resolve(dir, "endpoints.json");
  return { source: subset, endpoints: JSON.parse(readFileSync(subset, "utf8")).endpoints };
}

/**
 * Some catalog entries are a site root, not the paid path. CATALOG_PATHS_FILE maps a host
 * to the paid URLs to ask instead (agents/buyer/catalog-paths.json by default).
 */
export function loadPathOverrides(): Record<string, string[]> {
  const p = resolve(ROOT, process.env.CATALOG_PATHS_FILE ?? "agents/buyer/catalog-paths.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

/** Candidate URLs for a catalog_match, at most MAX_CATALOG_ENDPOINTS requests in total. */
export function selectCatalogUrls(entries: CatalogEntry[], m: CatalogMatch, overrides: Record<string, string[]>): string[] {
  const cats = m.categories?.map((c) => c.toLowerCase());
  const nets = m.networks?.map((n) => n.toLowerCase());
  const hosts = (m.hosts ?? payHosts()).map((h) => h.toLowerCase());
  const urls: string[] = [];
  const seen = new Set<string>();
  if (m.urls?.length) return m.urls.filter((u) => { const h = hostOf(u); return !!h && hosts.includes(h); }).slice(0, MAX_CATALOG_ENDPOINTS);
  for (const e of entries) {
    const host = hostOf(e.url);
    if (!host || !hosts.includes(host)) continue;
    if (cats && !cats.includes(String(e.category ?? "").toLowerCase())) continue;
    if (nets && !(e.networks ?? []).some((n) => nets.includes(n.toLowerCase()))) continue;
    const listed = e.price?.amount;
    if (m.max_price_usdc !== undefined && typeof listed === "number" && listed > m.max_price_usdc) continue;
    for (const u of overrides[host] ?? [e.url]) {
      if (seen.has(u)) continue;
      seen.add(u);
      urls.push(u);
    }
  }
  return urls.slice(0, MAX_CATALOG_ENDPOINTS);
}

export type Accept = { scheme: string; network: string; amount?: string; maxAmountRequired?: string; asset: string; payTo: string };

/** One GET, no retry. Returns the 402's payment options or why there are none. */
export async function fetch402(url: string, timeoutMs = 10_000): Promise<{ ok: true; accepts: Accept[] } | { ok: false; reason: string }> {
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  } catch (e: any) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timeout" : `request failed: ${e?.message ?? e}` };
  }
  if (r.status !== 402) return { ok: false, reason: `HTTP ${r.status} (not 402)` };
  const header = r.headers.get("payment-required");
  try {
    if (header) {
      const j = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      if (Array.isArray(j.accepts)) return { ok: true, accepts: j.accepts };
    }
    const body = await r.json(); // x402 v1 puts the requirements in the body
    if (Array.isArray(body?.accepts)) return { ok: true, accepts: body.accepts };
  } catch {
    /* fall through */
  }
  return { ok: false, reason: "402 without a readable accepts list" };
}

export type Picked = { ok: true; amount: bigint; payTo: string; network: string; payable: boolean } | { ok: false; reason: string };

/**
 * The exact/USDC option priced at or under the cap. Prefers a network this buyer can pay on;
 * otherwise returns a recognised USDC option elsewhere (e.g. Base) with payable=false, which is
 * recorded as a quote but never paid.
 */
export function pickAccept(accepts: Accept[], payable: string[], max: bigint): Picked {
  const exact = accepts.filter((a) => a.scheme === "exact");
  if (!exact.length) return { ok: false, reason: "no exact scheme offered" };
  const usdc = exact.filter((a) => USDC_BY_NETWORK[a.network] !== undefined && a.asset?.toLowerCase() === USDC_BY_NETWORK[a.network].toLowerCase());
  if (!usdc.length) return { ok: false, reason: `no USDC option on a known network (offered: ${[...new Set(exact.map((a) => a.network))].join(", ")})` };
  const problems: string[] = [];
  const ok: Extract<Picked, { ok: true }>[] = [];
  for (const a of usdc) {
    const raw = a.amount ?? a.maxAmountRequired;
    if (!raw || !/^\d+$/.test(raw)) { problems.push(`malformed amount ${raw}`); continue; }
    const amount = BigInt(raw);
    if (amount <= 0n) { problems.push("amount is 0"); continue; }
    if (amount > max) { problems.push(`price ${amount} > cap ${max}`); continue; }
    if (!a.payTo) { problems.push("no payTo"); continue; }
    ok.push({ ok: true, amount, payTo: a.payTo, network: a.network, payable: payable.includes(a.network) });
  }
  if (!ok.length) return { ok: false, reason: [...new Set(problems)].join("; ") };
  ok.sort((x, y) => Number(y.payable) - Number(x.payable) || payable.indexOf(x.network) - payable.indexOf(y.network) || (x.amount < y.amount ? -1 : 1));
  return ok[0];
}

/**
 * Catalog spend so far today (UTC), from the append-only run log. Counts every
 * payment the buyer signed (`x402_payment_sent`), delivered or not, Solana and Base together.
 * Test-network payments (devnet mock seller) are real-money-free and not counted; a record
 * without a network (older logs) is counted.
 */
export function catalogSpentToday(): bigint {
  const dir = resolve(ROOT, process.env.LOG_DIR ?? "log");
  const day = new Date().toISOString().slice(0, 10);
  const file = resolve(dir, `${day}.jsonl`);
  if (!existsSync(file)) return 0n;
  let sum = 0n;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      const real = !r.network || r.network === SOLANA_MAINNET_CAIP2 || r.network === BASE_MAINNET_CAIP2;
      if (r.step === "x402_payment_sent" && r.source === "catalog" && real && /^\d+$/.test(String(r.amount))) sum += BigInt(r.amount);
    } catch {
      /* skip malformed line */
    }
  }
  return sum;
}

