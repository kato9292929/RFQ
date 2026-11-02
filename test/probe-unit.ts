// Checks for the Seller Probe gate in lib/probe.ts: npx tsx test/probe-unit.ts
import assert from "node:assert/strict";
import { applyProbeFilter, probeNoPayReason, type ProbeLookup } from "../lib/probe.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { baseHosts, netFailures, payHosts, pickAccept, recordNetFailure } from "../lib/catalog.js";

const scored = (host: string, score: number): ProbeLookup =>
  ({ status: "scored", host, score, coverage: "full", last_paid: null, verdict: null, delivered: false, requires_input: null });
const q = (pubkey: string, host: string | null) => ({ pubkey, seller: `S-${pubkey}`, catalog: host ? { host } : null });

const quotes = [q("osd", "osd.x402jp.com"), q("jin", "jin.x402jp.com"), q("low", "low.example"), q("none", "none.example"), q("ok", "ok.example"), q("own-seller", null)];
const lookups = new Map<string, ProbeLookup>([
  ["osd", scored("osd.x402jp.com", 20)],
  ["jin", scored("jin.x402jp.com", 20)],
  ["low", scored("low.example", 30)],
  ["none", { status: "unscored", host: "none.example" }],
  ["ok", scored("ok.example", 95)],
  ["own-seller", scored("osd.x402jp.com", 20)],
]);
const r = applyProbeFilter(quotes, lookups, 50, baseHosts());

// own catalog hosts on CATALOG_PAY_HOSTS skip the score check
assert.deepEqual(r.exempt.map((e) => e.host), ["osd.x402jp.com", "jin.x402jp.com"]);
assert.ok(r.kept.some((k) => k.pubkey === "osd") && r.kept.some((k) => k.pubkey === "jin"));
// third parties: low score excluded, no score recorded as probe_unscored (kept as a quote), good score kept
assert.deepEqual(r.excluded.map((e) => e.quote), ["low", "own-seller"], "a non-catalog quote is not exempt even on an own host");
assert.deepEqual(r.unscored, [{ quote: "none", host: "none.example" }]);
assert.ok(r.kept.some((k) => k.pubkey === "ok"));
// ...and an unscored third party is still never paid
assert.match(probeNoPayReason({ status: "unscored", host: "none.example" })!, /not measured/);
assert.ok(!payHosts([]).includes("none.example"));
// without the exempt list, the old behaviour: own hosts below min are excluded
assert.deepEqual(applyProbeFilter(quotes, lookups, 50).excluded.map((e) => e.quote), ["osd", "jin", "low", "own-seller"]);
// Thresholds change the winner: cheapest kept quote wins (ties: the order quotes were recorded).
{
  const cands = [q("glim", "glim.sh"), q("surf", "surf.cascade.fyi"), q("fetch", "fetcher.sh"), q("own", "osd.x402jp.com")];
  const price: Record<string, number> = { glim: 1000, surf: 1000, fetch: 2000, own: 5000 };
  const lk = new Map<string, ProbeLookup>([
    ["glim", scored("glim.sh", 89.5)], ["surf", scored("surf.cascade.fyi", 91.1)], ["fetch", scored("fetcher.sh", 96.5)], ["own", scored("osd.x402jp.com", 20)],
  ]);
  const winner = (min: number) => {
    const kept = applyProbeFilter(cands, lk, min, baseHosts()).kept;
    return kept.reduce((w, k) => (price[k.pubkey] < price[w.pubkey] ? k : w), kept[0]).pubkey;
  };
  assert.deepEqual([0, 90, 95, 99].map(winner), ["glim", "surf", "fetch", "own"], "each step up drops the cheapest low scorer; own host stays");
}

// Network switch after a refused payment (x402helper.xyz on 10/29: Solana refused, Base worked).
{
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", BASE = "eip155:8453";
  const accepts = [
    { scheme: "exact", network: SOL, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "S", amount: "1000" },
    { scheme: "exact", network: BASE, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xB", amount: "1000" },
  ];
  assert.equal((pickAccept(accepts, [SOL, BASE], 10_000n) as any).network, SOL, "Solana first by default");
  const file = join(mkdtempSync(join(tmpdir(), "rfq-net-")), "failures.jsonl");
  assert.equal(netFailures(file).size, 0);
  recordNetFailure("x402helper.xyz", SOL, { rfq: "R" }, file);
  const avoid = netFailures(file).get("x402helper.xyz")!;
  assert.deepEqual(avoid, [SOL]);
  assert.equal((pickAccept(accepts, [SOL, BASE], 10_000n, avoid) as any).network, BASE, "next RFQ in the batch pays on Base");
  const solOnly = [accepts[0]];
  assert.match((pickAccept(solOnly, [SOL, BASE], 10_000n, avoid) as any).reason, /refused earlier/, "no other network offered → host dropped");
  recordNetFailure("x402helper.xyz", BASE, { rfq: "R2" }, file);
  assert.match((pickAccept(accepts, [SOL, BASE], 10_000n, netFailures(file).get("x402helper.xyz")) as any).reason, /refused earlier/);
}
console.log("probe checks passed");
