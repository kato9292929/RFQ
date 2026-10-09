// Build the seller's catalog snapshot from a read-only checkout of the public
// `endpoint` repository (https://github.com/kato9292929/endpoint). Nothing is
// written to that repository.
//   node scripts/build-catalog-snapshot.mjs /path/to/endpoint [out.json]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2];
const out = process.argv[3] ?? "agents/seller/data/catalog-snapshot.json";
if (!repo) throw new Error("usage: build-catalog-snapshot.mjs <endpoint-repo-path> [out]");

const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
const statsDir = join(repo, "data/stats");
const latest = readdirSync(statsDir).filter((f) => f.endsWith(".json")).sort().at(-1);
const stats = JSON.parse(readFileSync(join(statsDir, latest), "utf8"));
const rank = JSON.parse(readFileSync(join(repo, "data/rank.json"), "utf8"));
const providers = JSON.parse(readFileSync(join(repo, "data/providers.json"), "utf8"));

const snapshot = {
  source: {
    repo: "https://github.com/kato9292929/endpoint",
    commit,
    stats_file: `data/stats/${latest}`,
    generated_at: stats.generatedAt,
  },
  endpoint_count: stats.total,
  host_count: stats.hostCount,
  by_category: stats.byCategory,
  by_chain: stats.byChain,
  by_source: stats.bySource,
  by_price_tier: stats.byPriceTier,
  top_hosts: (stats.byHost ?? []).slice(0, 25),
  rank: {
    metric: rank.metric,
    generated_at: rank.generated_at,
    rows: rank.rows.slice(0, 20).map(({ rank: r, host, title, tx_count, total_amount, unique_buyers }) => ({
      rank: r, host, title, tx_count, total_amount, unique_buyers,
    })),
  },
  first_party_providers: (providers.firstParty ?? []).map(({ host, name, count, networks, brand }) => ({ host, name, count, networks, brand })),
};
writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`wrote ${out} (endpoint_count=${snapshot.endpoint_count}, host_count=${snapshot.host_count}, commit=${commit.slice(0, 7)})`);
