// Checks for the Seller Probe gate in lib/probe.ts: npx tsx test/probe-unit.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { adjustThreshold, applyProbeFilter, probeNoPayReason, type ProbeLookup } from "../lib/probe.js";
import { findLandedEvm } from "../lib/evm-pay.js";
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
// Per-RFQ lowering of min_probe_score (requested 99, min_candidates 2, floor 85)
{
  const qs = (xs: [string, number][]) => xs.map(([h]) => q(h, h));
  const lk = (xs: [string, number][]) => new Map<string, ProbeLookup>(xs.map(([h, sc]) => [h, scored(h, sc)]));
  // one candidate at 99 → lowered to the highest score that keeps 2
  const a: [string, number][] = [["a.example", 99.6], ["b.example", 95.8], ["c.example", 91.1], ["d.example", 88]];
  const ra = adjustThreshold(qs(a), lk(a), 99, 2, 85);
  assert.deepEqual([ra.reason, ra.effective, ra.passing_at_requested, ra.passing_at_effective], ["lowered", 95.8, 1, 2]);
  assert.ok(ra.effective >= 85 && ra.effective <= 99);
  assert.deepEqual(applyProbeFilter(qs(a), lk(a), ra.effective).kept.map((k) => k.pubkey), ["a.example", "b.example"]);
  // floor 85 still leaves one → floor_reached, award among the one left
  const b: [string, number][] = [["a.example", 99.6], ["low.example", 80]];
  const rb = adjustThreshold(qs(b), lk(b), 99, 2, 85);
  assert.deepEqual([rb.reason, rb.effective, rb.passing_at_effective], ["floor_reached", 85, 1]);
  assert.deepEqual(applyProbeFilter(qs(b), lk(b), rb.effective).kept.map((k) => k.pubkey), ["a.example"]);
  // enough at the requested score → unchanged
  assert.equal(adjustThreshold(qs(a), lk(a), 90, 2, 85).reason, "none");
  // own exempt host counts as passing and is never lowered for
  const c: [string, number][] = [["osd.x402jp.com", 20], ["x.example", 92]];
  assert.deepEqual([adjustThreshold(qs(c), lk(c), 99, 2, 85, baseHosts()).effective], [92]);
  // lowering never lets in an unscored third party or a non-delivered verdict: they fail the payment
  // gate first (the buyer only adjusts over quotes that passed it)
  const gate = (l: ProbeLookup) => probeNoPayReason(l) === null;
  const nd: ProbeLookup = { status: "scored", host: "nd.example", score: 98, coverage: "full", last_paid: null, verdict: "not_delivered", delivered: false, requires_input: null };
  const ok: ProbeLookup = { status: "scored", host: "ok.example", score: 99.5, coverage: "full", last_paid: { ts: "", url: "", network: null, amount: null, verdict: "delivered", tx: null }, verdict: "delivered", delivered: true, requires_input: null };
  const un: ProbeLookup = { status: "unscored", host: "un.example" };
  const all = [["ok.example", ok], ["nd.example", nd], ["un.example", un]] as const;
  const payable = all.filter(([, l]) => gate(l)).map(([h]) => h);
  assert.deepEqual(payable, ["ok.example"]);
  const r = adjustThreshold(payable.map((h) => q(h, h)), new Map(payable.map((h) => [h, ok])), 99, 2, 85);
  assert.equal(r.reason, "floor_reached");
  assert.deepEqual(applyProbeFilter(payable.map((h) => q(h, h)), new Map(payable.map((h) => [h, ok])), r.effective).kept.map((k) => k.pubkey), ["ok.example"]);
}

// Base RPC: a 429 RPC is retried, then the next RPC answers; nothing is ever sent.
{
  const methods: string[] = [];
  const serve = (handler: (body: any, res: any) => void) => new Promise<{ url: string; close: () => void; hits: () => number }>((resolve) => {
    let hits = 0;
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { hits++; const j = JSON.parse(b); methods.push(j.method); handler(j, res); });
    }).listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as any;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close(), hits: () => hits });
    });
  });
  const limited = await serve((_j, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit"}}'); });
  const TX = "0x" + "ab".repeat(32);
  const good = await serve((j, res) => {
    const result = j.method === "eth_call" ? "0x" + "0".repeat(63) + "1"
      : j.method === "eth_blockNumber" ? "0x1000"
      : j.method === "eth_getLogs" ? [{ transactionHash: TX }]
      : j.method === "eth_getTransactionReceipt" ? { status: "0x1", logs: [], blockNumber: "0x1000" } : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
  });
  const payer = { kind: "evm" as const, network: "eip155:8453", address: "0x" + "11".repeat(20), privateKey: "0x" as any, rpcUrl: "", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as any };
  const nonce = ("0x" + "cd".repeat(32)) as `0x${string}`;
  const l = await findLandedEvm(payer, nonce, 5000, { urls: [limited.url, good.url], attempts: 3, delayMs: 10 });
  assert.equal(l.status, "landed");
  assert.equal((l as any).hash, TX);
  assert.equal((l as any).rpc, new URL(good.url).host, "answered by the second RPC");
  assert.ok(limited.hits() >= 3, "the 429 RPC was retried before switching");
  // every RPC down → unknown (not 'failed'), still no send
  const u = await findLandedEvm(payer, nonce, 300, { urls: [limited.url], attempts: 2, delayMs: 10 });
  assert.equal(u.status, "unknown");
  assert.ok(methods.every((m) => ["eth_call", "eth_blockNumber", "eth_getLogs", "eth_getTransactionReceipt"].includes(m)), "reads only; no transaction was (re)sent");
  limited.close();
  good.close();
}
console.log("probe checks passed");
