// Checks for lib/catalog.ts: npx tsx test/catalog-unit.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "rfq-catalog-"));
process.env.LOG_DIR = dir;
const C = await import("../lib/catalog.js");
const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const acc = (o: Record<string, string>) => ({ scheme: "exact", network: NET, asset: USDC, payTo: "Pay", amount: "1000", ...o });

// pickAccept: payable networks first, other known-USDC networks recorded as payable=false
const BASE = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEV = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
assert.deepEqual(C.pickAccept([acc({})], [NET], 10_000n), { ok: true, amount: 1000n, payTo: "Pay", network: NET, payable: true });
assert.match((C.pickAccept([acc({ amount: "20000" })], [NET], 10_000n) as any).reason, /> cap/);
assert.deepEqual(C.pickAccept([acc({ network: BASE, asset: BASE_USDC })], [NET], 10_000n), { ok: true, amount: 1000n, payTo: "Pay", network: BASE, payable: false });
assert.equal((C.pickAccept([acc({ network: BASE, asset: BASE_USDC, amount: "500" }), acc({})], [NET], 10_000n) as any).network, NET, "payable beats cheaper unpayable");
assert.equal((C.pickAccept([acc({}), acc({ network: DEV, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" })], [DEV, NET], 10_000n) as any).network, DEV, "payer order");
assert.match((C.pickAccept([acc({ asset: "Other" })], [NET], 10_000n) as any).reason, /no USDC option/);
assert.match((C.pickAccept([acc({ scheme: "upto" })], [NET], 10_000n) as any).reason, /no exact/);
assert.match((C.pickAccept([acc({ amount: "1e3" })], [NET], 10_000n) as any).reason, /malformed/);

// pay hosts: own + Probe-delivered; re-requests only to own/local hosts
assert.deepEqual(C.payHosts(), ["osd.x402jp.com", "jin.x402jp.com"]);
assert.deepEqual(C.payHosts(null), ["osd.x402jp.com", "jin.x402jp.com"], "Probe down → own hosts only");
assert.deepEqual(C.payHosts(["surf.cascade.fyi", "osd.x402jp.com"]), ["osd.x402jp.com", "jin.x402jp.com", "surf.cascade.fyi"]);
assert.equal(C.retryAllowed("jin.x402jp.com"), true);
assert.equal(C.retryAllowed("127.0.0.1"), true);
assert.equal(C.retryAllowed("surf.cascade.fyi"), false);

// explicit urls skip the catalog but still honour the host list
assert.deepEqual(C.selectCatalogUrls([], { hosts: ["surf.cascade.fyi"], urls: ["https://surf.cascade.fyi/a", "https://evil.example/b"] }, {}), ["https://surf.cascade.fyi/a"]);

// caps: env can only lower them
assert.equal(C.maxPerCall(), 10_000n);
process.env.CATALOG_MAX_PER_CALL = "50000";
assert.equal(C.maxPerCall(), 10_000n, "env must not raise the per-call cap");
process.env.CATALOG_MAX_PER_CALL = "5000";
assert.equal(C.maxPerCall(), 5_000n);
process.env.CATALOG_MAX_PER_DAY = "9999999";
assert.equal(C.maxPerDay(), 500_000n, "env must not raise the daily cap");
delete process.env.CATALOG_MAX_PER_CALL;
delete process.env.CATALOG_MAX_PER_DAY;

// daily spend counts signed catalog payments only, today's file only
mkdirSync(dir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
writeFileSync(join(dir, `${day}.jsonl`), [
  { step: "x402_payment_sent", source: "catalog", amount: "10000" },
  { step: "x402_payment_sent", source: "catalog", amount: "2500", network: "eip155:8453" },
  { step: "x402_payment_sent", source: "catalog", amount: "5000", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
  { step: "x402_payment_sent", source: "seller", amount: "35000" },
  { step: "x402_paid", source: "catalog", amount: "10000" },
].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
writeFileSync(join(dir, "2000-01-01.jsonl"), JSON.stringify({ step: "x402_payment_sent", source: "catalog", amount: "999999" }) + "\n");
assert.equal(C.catalogSpentToday(), 12_500n);

// selection: allowlisted hosts, category/network/price filters, path overrides, max 5 requests
const entries = [
  { url: "https://osd.x402jp.com", category: "data", networks: ["Solana", "Base"], price: { amount: 0.01 } },
  { url: "https://jin.x402jp.com", category: "data", networks: ["Solana"], price: { amount: 0.01 } },
  { url: "https://other.example.com/x", category: "data", networks: ["Solana"], price: { amount: 0.001 } },
  { url: "https://pricey.x402jp.com", category: "data", networks: ["Solana"], price: { amount: 0.5 } },
];
const urls = C.selectCatalogUrls(entries, { categories: ["data"], networks: ["Solana"], max_price_usdc: 0.01, hosts: ["osd.x402jp.com", "jin.x402jp.com", "pricey.x402jp.com"] },
  { "jin.x402jp.com": ["https://jin.x402jp.com/api/jin/series", "https://jin.x402jp.com/api/jin/movers"] });
assert.deepEqual(urls, ["https://osd.x402jp.com", "https://jin.x402jp.com/api/jin/series", "https://jin.x402jp.com/api/jin/movers"]);
const many = Array.from({ length: 9 }, (_, i) => `https://osd.x402jp.com/p${i}`);
assert.equal(C.selectCatalogUrls(entries.slice(0, 1), { hosts: ["osd.x402jp.com"] }, { "osd.x402jp.com": many }).length, 5);
assert.deepEqual(C.selectCatalogUrls(entries, {}, {}), ["https://osd.x402jp.com", "https://jin.x402jp.com"], "default hosts = CATALOG_PAY_HOSTS (OSD, JIN)");
console.log("catalog checks passed");
