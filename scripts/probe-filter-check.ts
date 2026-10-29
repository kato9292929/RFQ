// Checks the buyer's min_probe_score filter against the live Probe API, without a chain:
// the devnet scenario's local sellers (127.0.0.1) must stay (unscored), as must any host the
// Probe has no number for; only a scored host below the minimum is dropped.
//   npx tsx scripts/probe-filter-check.ts [extra-endpoint-url ...]
import { readFileSync } from "node:fs";
import { applyProbeFilter, checkMinProbeScore, lookupProbe, type ProbeLookup } from "../lib/probe.js";

const spec = JSON.parse(readFileSync("scenarios/probe-min-score.json", "utf8"));
const min = checkMinProbeScore(spec.min_probe_score)!;
const endpoints = ["http://127.0.0.1:8801/data", "http://127.0.0.1:8802/data", ...process.argv.slice(2)];
const quotes = endpoints.map((e, i) => ({ pubkey: `quote${i + 1}`, seller: `seller${i + 1}`, endpoint: e }));
const lookups = new Map<string, ProbeLookup>();
for (const q of quotes) lookups.set(q.pubkey, await lookupProbe(q.endpoint));
const r = applyProbeFilter(quotes, lookups, min);
for (const q of quotes) console.log(`${q.endpoint} → ${JSON.stringify(lookups.get(q.pubkey))} → ${r.kept.includes(q) ? "kept" : "excluded"}`);
console.log(JSON.stringify({ min_probe_score: min, kept: r.kept.map((q) => q.endpoint), excluded: r.excluded, unscored: r.unscored, unavailable: r.unavailable }, null, 1));
const local = quotes.slice(0, 2);
if (!local.every((q) => r.kept.includes(q))) {
  console.error("FAIL: a local (unscored) seller was excluded");
  process.exit(1);
}
