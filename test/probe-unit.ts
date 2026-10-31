// Checks for the Seller Probe gate in lib/probe.ts: npx tsx test/probe-unit.ts
import assert from "node:assert/strict";
import { applyProbeFilter, probeNoPayReason, type ProbeLookup } from "../lib/probe.js";
import { baseHosts, payHosts } from "../lib/catalog.js";

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
console.log("probe checks passed");
