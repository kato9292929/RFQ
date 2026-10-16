// Catalog quotes: turn x402 Endpoint catalog entries into quotes by reading each
// endpoint's own 402 price. Sellers implement nothing; the buyer records the quote.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ROOT } from "./common.js";

export type CatalogEntry = { url: string; category?: string; networks?: string[]; price?: { amount?: number } | null };
export type CatalogMatch = {
  categories?: string[];
  networks?: string[]; // catalog chain names, e.g. "Solana"
  max_price_usdc?: number;
  hosts?: string[];
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

/** Hosts the buyer may pay through catalog quotes (first week: our own OSD and JIN only). */
export function payHosts(): string[] {
  return (process.env.CATALOG_PAY_HOSTS ?? "osd.x402jp.com,jin.x402jp.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
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

/** The exact/USDC option on our network, priced at or under the cap. */
export function pickAccept(
  accepts: Accept[], network: string, asset: string, max: bigint,
): { ok: true; amount: bigint; payTo: string; network: string } | { ok: false; reason: string } {
  const exact = accepts.filter((a) => a.scheme === "exact");
  if (!exact.length) return { ok: false, reason: "no exact scheme offered" };
  const onNet = exact.filter((a) => a.network === network);
  if (!onNet.length) return { ok: false, reason: `not offered on ${network} (offered: ${[...new Set(exact.map((a) => a.network))].join(", ")})` };
  const usdc = onNet.filter((a) => a.asset === asset);
  if (!usdc.length) return { ok: false, reason: `not priced in ${asset}` };
  const a = usdc[0];
  const raw = a.amount ?? a.maxAmountRequired;
  if (!raw || !/^\d+$/.test(raw)) return { ok: false, reason: `malformed amount ${raw}` };
  const amount = BigInt(raw);
  if (amount <= 0n) return { ok: false, reason: "amount is 0" };
  if (amount > max) return { ok: false, reason: `price ${amount} > cap ${max}` };
  if (!a.payTo) return { ok: false, reason: "no payTo" };
  return { ok: true, amount, payTo: a.payTo, network: a.network };
}

/**
 * Catalog spend so far today (UTC), from the append-only run log. Counts every
 * payment the buyer signed (`x402_payment_sent`), delivered or not.
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
      if (r.step === "x402_payment_sent" && r.source === "catalog" && /^\d+$/.test(String(r.amount))) sum += BigInt(r.amount);
    } catch {
      /* skip malformed line */
    }
  }
  return sum;
}

