// log/run-YYYYMMDD.md for one scripts/run-threshold.sh batch: per threshold, how min_probe_score
// changed which catalog quote won, at what price and latency.
//   npx tsx scripts/run-threshold-report.ts <batch> <out.md> [sellers.json] [log/YYYY-MM-DD.jsonl ...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, fmtUsdc } from "../lib/common.js";
import { BASE_MAINNET_CAIP2, SOLANA_MAINNET_CAIP2, explorerFor } from "../lib/payment-net.js";

const [batch, outPath, sellersFile, ...files] = process.argv.slice(2);
if (!batch || !outPath) throw new Error("usage: run-threshold-report.ts <batch> <out.md> [sellers.json] [jsonl...]");
const logs = files.length ? files : [resolve(ROOT, "log", `${new Date().toISOString().slice(0, 10)}.jsonl`)];
const rows: any[] = [];
for (const f of logs) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    try {
      const r = JSON.parse(line);
      if (String(r.scenario ?? "").startsWith(batch)) rows.push(r);
    } catch {
      /* skip */
    }
  }
}
const byScenario = new Map<string, any[]>();
for (const r of rows) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r]);
const net = (n?: string | null) => (n === SOLANA_MAINNET_CAIP2 ? "Solana" : n === BASE_MAINNET_CAIP2 ? "Base" : n?.startsWith("solana:Et") ? "devnet" : n ?? "-");
const short = (s?: string | null, n = 12) => (s ? `${s.slice(0, n)}…` : "-");

type Rfq = {
  T: number; cat: string; winner: string | null; price: bigint | null; latency: number | null; outcome: string; payNet: string | null;
  payTx: string | null; recordTx: string | null; wall: number | null; decisions: any[]; amount: bigint; landed: boolean; notes: string[];
};
const out: Rfq[] = [];
for (const [, rs] of byScenario) {
  const one = (s: string) => rs.filter((r) => r.step === s).at(-1);
  const round = one("catalog_round");
  if (!round) continue;
  const dec = one("quote_decisions")?.decisions ?? [];
  const award = one("award");
  const winDec = award ? dec.find((d: any) => d.quote === award.quote) : null;
  const sent = one("x402_payment_sent");
  const paid = one("x402_paid");
  const dws = one("x402_delivered_without_settlement");
  const failed = one("x402_paid_request_failed");
  const ful = one("record_fulfillment");
  const rej = one("record_rejection");
  const cancel = one("cancel_rfq");
  const cap = one("catalog_cap_refused");
  const notes: string[] = [];
  let outcome: string;
  if (ful) outcome = ful.outcome ?? "fulfilled";
  else if (rej) outcome = rej.reason === "not_delivered" ? "not_delivered" : `rejected (${rej.reason})`;
  else if (cap) outcome = "awarded, not paid (daily cap)";
  else if (failed && !failed.landed_payment_tx) outcome = "purchase not completed (payment refused, nothing landed)";
  else if (cancel) outcome = "no eligible quote (cancelled)";
  else outcome = `error (exit ${round.exit})`;
  const nf = one("net_failure");
  if (nf) notes.push(`payment refused on ${net(nf.network)} → (${nf.host}, ${net(nf.network)}) remembered for the rest of the batch`);
  for (const r of rs.filter((x) => x.step === "catalog_402" && !x.ok)) notes.push(`${r.url}: not quoted (${r.reason})`);
  out.push({
    T: round.threshold, cat: round.category, winner: winDec?.host ?? null, price: award ? BigInt(award.price) : null,
    latency: paid?.latency_ms ?? null, outcome, payNet: sent?.network ?? null, payTx: paid?.payment_tx ?? failed?.landed_payment_tx ?? null,
    recordTx: ful?.tx ?? rej?.tx ?? cancel?.tx ?? null, wall: round.wall_seconds ?? null, decisions: dec,
    amount: sent ? BigInt(sent.amount) : 0n, landed: !!(paid && !dws) || !!failed?.landed_payment_tx, notes,
  });
}
const thresholds = [...new Set(out.map((o) => o.T))].sort((a, b) => a - b);
const cats = [...new Set(out.map((o) => o.cat))];
const at = (T: number, c: string) => out.find((o) => o.T === T && o.cat === c);
const base = thresholds[0];

const L: string[] = [];
L.push(`# Run ${batch}: min_probe_score on competing catalog quotes`, "");
L.push("Records on Solana devnet; the one awarded catalog quote per RFQ paid in mainnet USDC (Solana or Base, as its 402 asks). Each catalog field is one RFQ with several sellers, run once per threshold.", "");
const real = out.filter((o) => o.payNet === SOLANA_MAINNET_CAIP2 || o.payNet === BASE_MAINNET_CAIP2);
const landed = real.filter((o) => o.landed);
const sum = (xs: Rfq[]) => xs.reduce((s, o) => s + o.amount, 0n);
L.push("## Summary", "");
L.push(`- mainnet payments landed: **${landed.length}**, **${fmtUsdc(sum(landed))} USDC** (Solana ${landed.filter((o) => o.payNet === SOLANA_MAINNET_CAIP2).length} / ${fmtUsdc(sum(landed.filter((o) => o.payNet === SOLANA_MAINNET_CAIP2)))}, Base ${landed.filter((o) => o.payNet === BASE_MAINNET_CAIP2).length} / ${fmtUsdc(sum(landed.filter((o) => o.payNet === BASE_MAINNET_CAIP2)))})`);
L.push(`- payments signed but not landed: ${real.length - landed.length}`);
L.push(`- RFQs: ${out.length} (${cats.length} fields × ${thresholds.length} thresholds)`, "");

L.push("| 閾値 | RFQ数 | 見積もり数 | 外れた数(理由別) | 採択先が変わったRFQ | 平均価格 | 平均応答時間 | 成立 | 未納品 |", "|---:|---:|---:|---|---:|---:|---:|---:|---:|");
for (const T of thresholds) {
  const xs = out.filter((o) => o.T === T);
  const ex: Record<string, number> = {};
  let nq = 0;
  for (const o of xs) for (const d of o.decisions) {
    nq++;
    if (d.decision === "excluded") ex[d.code] = (ex[d.code] ?? 0) + 1;
  }
  const changed = xs.filter((o) => T !== base && at(base, o.cat)?.winner !== o.winner).length;
  const prices = xs.filter((o) => o.price !== null).map((o) => o.price!);
  const lats = xs.filter((o) => o.latency !== null).map((o) => o.latency!);
  const avgP = prices.length ? fmtUsdc(prices.reduce((s, p) => s + p, 0n) / BigInt(prices.length)) : "-";
  const avgL = lats.length ? `${Math.round(lats.reduce((s, l) => s + l, 0) / lats.length)} ms` : "-";
  const exs = Object.entries(ex).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "0";
  const ok = xs.filter((o) => o.outcome === "fulfilled" || o.outcome === "recovered").length;
  const nd = xs.filter((o) => o.outcome === "not_delivered").length;
  L.push(`| ${T} | ${xs.length} | ${nq} | ${Object.values(ex).reduce((s, v) => s + v, 0)} (${exs}) | ${T === base ? "-" : changed} | ${avgP} | ${avgL} | ${ok} | ${nd} |`);
}
L.push("", "平均価格は採択した見積もりの価格、平均応答時間は有料呼び出しの往復時間（支払って本文を受け取るまで）。成立には取り直しで回収した分を含む。", "");

L.push("## 閾値を上げて採択先が変わった RFQ", "", `基準は閾値 ${base} の回。`, "");
L.push("| 分野 | 閾値 | 採択先（基準 → この回） | 価格（基準 → この回） | 応答時間（基準 → この回） | 結果 |", "|---|---:|---|---|---|---|");
for (const c of cats) for (const T of thresholds) {
  if (T === base) continue;
  const b = at(base, c), o = at(T, c);
  if (!b || !o || b.winner === o.winner) continue;
  const p = (x?: bigint | null) => (x === null || x === undefined ? "-" : fmtUsdc(x));
  const signed = (d: bigint) => `${d < 0n ? "-" : "+"}${fmtUsdc(d < 0n ? -d : d)}`;
  const diff = b.price !== null && o.price !== null ? ` (${signed(o.price - b.price)})` : "";
  L.push(`| ${c} | ${T} | ${b.winner ?? "なし"} → ${o.winner ?? "なし"} | ${p(b.price)} → ${p(o.price)}${diff} | ${b.latency ?? "-"} → ${o.latency ?? "-"} ms | ${o.outcome} |`);
}
L.push("");

if (sellersFile && existsSync(sellersFile)) {
  const sellers: any[] = JSON.parse(readFileSync(sellersFile, "utf8"));
  const hosts = new Set(out.flatMap((o) => o.decisions.map((d: any) => d.host)));
  L.push("## 網ごとの成績（indexer GET /sellers、devnet の全記録）", "");
  L.push("| host | 網 | 成立 | 拒否 | 未完了 |", "|---|---|---:|---:|---:|");
  for (const s of sellers.filter((x) => x.host && hosts.has(x.host)).sort((a, b) => a.host.localeCompare(b.host)))
    for (const [n, v] of Object.entries<any>(s.by_network ?? {})) L.push(`| ${s.host} | ${net(n)} | ${v.fulfilled} | ${v.rejected} | ${v.not_completed} |`);
  L.push("");
}

L.push("## RFQ ごとの明細", "");
for (const c of cats) for (const T of thresholds) {
  const o = at(T, c);
  if (!o) continue;
  L.push(`### ${c} / 閾値 ${T}`, "");
  L.push("| 候補 | 価格 | 網 | Probe スコア / 判定 | 結果 | 理由 |", "|---|---:|---|---|---|---|");
  for (const d of o.decisions) {
    const tag = d.decision === "excluded" ? d.code : d.code === "kept" ? (d.probe_tag === "scored_ok" ? "kept" : d.probe_tag) : d.code;
    L.push(`| ${d.host}${o.winner === d.host ? " **(採択)**" : ""} | ${fmtUsdc(d.price)} | ${net(d.network)} | ${d.probe_score ?? "-"} / ${d.probe_verdict ?? d.probe_status} | ${d.decision === "excluded" ? "外れた" : "残った"} | ${tag}${d.decision === "excluded" && d.probe_tag !== "scored_ok" && d.code !== d.probe_tag ? ` (Probe: ${d.probe_tag})` : ""} |`);
  }
  L.push("");
  L.push(`- 採択: ${o.winner ?? "なし"}${o.price !== null ? ` ${fmtUsdc(o.price)} USDC` : ""}`);
  L.push(`- 支払い: ${o.payTx ? `${net(o.payNet)} [${short(o.payTx)}](${explorerFor(o.payNet ?? "", o.payTx)})` : "なし"}${o.latency !== null ? `、応答 ${o.latency} ms` : ""}`);
  L.push(`- devnet の記録: ${o.recordTx ? `[${short(o.recordTx)}](https://explorer.solana.com/tx/${o.recordTx}?cluster=devnet)` : "-"}`);
  L.push(`- 結果: ${o.outcome}（${o.wall ?? "-"} 秒）`);
  for (const n of o.notes) L.push(`- ${n}`);
  L.push("");
}
writeFileSync(resolve(ROOT, outPath), L.join("\n"));
console.log(`wrote ${outPath}: ${out.length} RFQ(s), mainnet landed ${fmtUsdc(sum(landed))} USDC`);
