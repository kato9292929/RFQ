// Third-party hosts to buy from once: x402 Seller Probe's latest paid measurement of the host
// was `delivered` (納品), no input is required, at or under the per-call cap. Prints JSON [{host, url, network, amount, score, probe_tx}].
// Our own hosts (OSD, JIN) are bought separately and excluded here.
//   npx tsx scripts/probe-targets.ts > run/mixed/targets.json
import { OWN_HOSTS, maxPerCall } from "../lib/catalog.js";
import { PROBE_URL, lookupProbe, probeNoPayReason } from "../lib/probe.js";

const r = await fetch(`${PROBE_URL()}/scores`, { signal: AbortSignal.timeout(60_000) });
if (!r.ok) throw new Error(`Probe /scores → HTTP ${r.status}`);
const all: any[] = (await r.json()).scores ?? [];
const candidates = all.filter((s) => (s.paid_outcomes?.delivered ?? 0) > 0 && !OWN_HOSTS.includes(s.host));
const out = [];
for (const c of candidates) {
  const l = await lookupProbe(`https://${c.host}/`);
  // latest paid verdict must be delivered, and no input required
  if (l.status !== "scored" || probeNoPayReason(l) !== null || !l.last_paid) { console.error(`skip ${c.host}: ${probeNoPayReason(l)}`); continue; }
  const amount = BigInt(l.last_paid.amount ?? "0");
  if (amount <= 0n || amount > maxPerCall()) continue;
  out.push({ host: l.host, url: l.last_paid.url, network: l.last_paid.network, amount: amount.toString(), score: l.score, probe_tx: l.last_paid.tx, probe_ts: l.last_paid.ts });
}
out.sort((a, b) => a.host.localeCompare(b.host));
console.error(`probe: ${candidates.length} host(s) with a delivered paid measurement, ${out.length} whose latest paid result is delivered and ≤ cap`);
console.log(JSON.stringify(out, null, 2));
