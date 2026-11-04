// log/run-YYYYMMDD.md for an auto-threshold batch (scripts/run-threshold.sh with REPORT=auto):
// requested vs effective min_probe_score per field, the winner, and the 2026-11-02 threshold-99 run
// side by side.   npx tsx scripts/run-auto-report.ts <batch> <out.md> [quotes.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, fmtUsdc } from "../lib/common.js";
import { BASE_MAINNET_CAIP2, SOLANA_MAINNET_CAIP2, explorerFor } from "../lib/payment-net.js";

const [batch, outPath, quotesFile] = process.argv.slice(2);
const read = (f: string, prefix: string) =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").flatMap((l) => { try { const r = JSON.parse(l); return String(r.scenario ?? "").startsWith(prefix) ? [r] : []; } catch { return []; } }) : [];
const day = (b: string) => { const m = b.match(/(\d{4})(\d{2})(\d{2})/)!; return `${m[1]}-${m[2]}-${m[3]}`; };
const net = (n?: string | null) => (n === SOLANA_MAINNET_CAIP2 ? "Solana" : n === BASE_MAINNET_CAIP2 ? "Base" : n ?? "-");
const mainnetRpcHost = (() => { try { return new URL(process.env.MAINNET_RPC_URL ?? "").host; } catch { return "MAINNET_RPC_URL"; } })();

type Row = { cat: string; req: number | null; eff: number | null; reason: string; cands: string; winner: string | null; price: bigint | null;
  latency: number | null; outcome: string; rpc: string; payNet: string | null; payTx: string | null; recordTx: string | null; decisions: any[]; notes: string[] };
function rows(all: any[], filterT?: number): Row[] {
  const by = new Map<string, any[]>();
  for (const r of all) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r]);
  const out: Row[] = [];
  for (const [, rs] of by) {
    const one = (s: string) => rs.filter((r) => r.step === s).at(-1);
    const round = one("catalog_round");
    if (!round || (filterT !== undefined && round.threshold !== filterT)) continue;
    const dec = one("quote_decisions")?.decisions ?? [];
    const ta = one("threshold_adjust");
    const award = one("award");
    const win = award ? dec.find((d: any) => d.quote === award.quote) : null;
    const sent = one("x402_payment_sent"), paid = one("x402_paid"), failed = one("x402_paid_request_failed");
    const ful = one("record_fulfillment"), rej = one("record_rejection"), cancel = one("cancel_rfq"), unk = one("settlement_unknown");
    const ver = one("indexer_verification");
    const notes: string[] = [];
    let outcome = ful ? (ful.outcome ?? "fulfilled") : rej ? (rej.reason === "not_delivered" ? "not_delivered" : `rejected (${rej.reason})`)
      : unk ? "settlement_unknown" : failed && !failed.landed_payment_tx ? "payment refused (nothing landed)" : cancel ? "cancelled (no eligible quote)" : `error (exit ${round.exit})`;
    if (one("settlement_resolved")) outcome = `payment refused (resolved at end: ${one("settlement_resolved").result})`;
    if (ful?.resolved_after || rej?.resolved_after) notes.push("recorded by the end-of-batch check (scripts/resolve-pending.ts)");
    const nf = one("net_failure");
    if (nf) notes.push(`(${nf.host}, ${net(nf.network)}) refused the payment`);
    for (const r of rs.filter((x) => x.step === "catalog_402" && !x.ok)) notes.push(`${new URL(r.url).host}: not quoted (${r.reason})`);
    const rpc = !sent ? "-" : sent.network === SOLANA_MAINNET_CAIP2 ? mainnetRpcHost
      : ver?.verification?.details?.rpc ?? paid?.verify_rpc ?? (ful?.verify_rpc ?? rej?.verify_rpc ?? "-");
    const payable = dec.filter((d: any) => d.decision === "kept").length;
    out.push({
      cat: round.category, req: ta?.requested_min_probe_score ?? one("quote_decisions")?.min_probe_score ?? round.threshold ?? null,
      eff: ta?.effective_min_probe_score ?? one("quote_decisions")?.min_probe_score ?? null,
      reason: ta ? (ta.reason === "none" ? "-" : ta.reason === "lowered" ? `lowered: ${ta.passing_at_requested} → ${ta.passing_at_effective} 件（${ta.min_candidates} 件必要）` : `floor ${ta.floor}: ${ta.passing_at_effective} 件のみ`) : "-",
      cands: `${payable} / ${dec.length}`, winner: win?.host ?? null, price: award ? BigInt(award.price) : null, latency: paid?.latency_ms ?? null,
      outcome, rpc, payNet: sent?.network ?? null, payTx: paid?.payment_tx ?? failed?.landed_payment_tx ?? rej?.payment_tx ?? ful?.payment_tx ?? null,
      recordTx: ful?.tx ?? rej?.tx ?? cancel?.tx ?? null, decisions: dec, notes,
    });
  }
  return out.sort((a, b) => a.cat.localeCompare(b.cat));
}

const now = rows(read(resolve(ROOT, "log", `${day(batch)}.jsonl`), batch));
const prev = rows(read(resolve(ROOT, "log", "2026-11-02.jsonl"), "threshold-20261102-1229"), 99);
const P = (x: bigint | null) => (x === null ? "-" : fmtUsdc(x));
const L: string[] = [];
L.push(`# Run ${batch}: per-field automatic min_probe_score`, "");
L.push("min_probe_score 99 with min_candidates 2 and probe_score_floor 85 (defaults), one RFQ per field. Records on Solana devnet; the awarded catalog quote paid in mainnet USDC.", "");
const landed = now.filter((r) => r.payTx);
L.push(`- mainnet payments landed: ${landed.length}, ${fmtUsdc(landed.reduce((s, r) => s + (r.price ?? 0n), 0n))} USDC`);
L.push(`- Base RPC order: ${process.env.BASE_RPC_URL ? "BASE_RPC_URL, then " : ""}mainnet.base.org → base-rpc.publicnode.com → base.drpc.org${process.env.BASE_RPC_URL ? "" : " (BASE_RPC_URL not set yet)"}`, "");
L.push("| 分野 | 指定閾値 | 実効閾値 | 下げた理由 | 候補数（支払い可 / 見積もり） | 採択先 | 価格 | 応答時間 | 結果 | 使ったRPC |", "|---|---:|---:|---|---|---|---:|---:|---|---|");
for (const r of now) L.push(`| ${r.cat} | ${r.req ?? "-"} | ${r.eff ?? "-"} | ${r.reason} | ${r.cands} | ${r.winner ?? "なし"} | ${P(r.price)} | ${r.latency !== null ? `${r.latency} ms` : "-"} | ${r.outcome} | ${r.rpc} |`);
L.push("", "## 2026-11-02 の閾値 99（自動調整なし）との違い", "");
L.push("| 分野 | 11/2 採択先 | 11/2 価格 | 11/2 結果 | 今回 採択先 | 今回 価格 | 今回 結果 |", "|---|---|---:|---|---|---:|---|");
for (const r of now) {
  const p = prev.find((x) => x.cat === r.cat);
  L.push(`| ${r.cat} | ${p?.winner ?? "なし"} | ${P(p?.price ?? null)} | ${p?.outcome ?? "-"} | ${r.winner ?? "なし"} | ${P(r.price)} | ${r.outcome} |`);
}
L.push("");
if (quotesFile && existsSync(quotesFile)) {
  const qs: any[] = JSON.parse(readFileSync(quotesFile, "utf8"));
  const mine = new Set(now.flatMap((r) => r.decisions.map((d: any) => d.quote)));
  const got = qs.filter((q) => mine.has(q.pubkey));
  L.push(`GET /quotes: ${got.length} quote(s) of this batch carry requested_min_probe_score / effective_min_probe_score (${got.filter((q) => q.effective_min_probe_score !== null).length} with a value).`, "");
}
L.push("## RFQ ごとの明細", "");
for (const r of now) {
  L.push(`### ${r.cat}`, "", `指定 ${r.req} → 実効 ${r.eff}（${r.reason}）`, "");
  L.push("| 候補 | 価格 | 網 | Probe スコア / 判定 | 結果 | 理由 |", "|---|---:|---|---|---|---|");
  for (const d of r.decisions)
    L.push(`| ${d.host}${d.host === r.winner ? " **(採択)**" : ""} | ${fmtUsdc(d.price)} | ${net(d.network)} | ${d.probe_score ?? "-"} / ${d.probe_verdict ?? d.probe_status} | ${d.decision === "excluded" ? "外れた" : "残った"} | ${d.decision === "excluded" ? d.code : d.code === "kept" ? d.probe_tag : d.code} |`);
  L.push("", `- 支払い: ${r.payTx ? `${net(r.payNet)} [${r.payTx.slice(0, 12)}…](${explorerFor(r.payNet ?? "", r.payTx)})` : "なし"}；devnet の記録: ${r.recordTx ? `[${r.recordTx.slice(0, 12)}…](https://explorer.solana.com/tx/${r.recordTx}?cluster=devnet)` : "-"}`);
  for (const n of r.notes) L.push(`- ${n}`);
  L.push("");
}
writeFileSync(resolve(ROOT, outPath), L.join("\n"));
console.log(`wrote ${outPath}: ${now.length} RFQ(s)`);
