// log/run-YYYYMMDD.md from the append-only run log, for one batch of scripts/run-mixed.sh.
//   npx tsx scripts/run-report.ts <batch-prefix> <out.md> [log/YYYY-MM-DD.jsonl ...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, fmtUsdc } from "../lib/common.js";
import { SOLANA_MAINNET_CAIP2, BASE_MAINNET_CAIP2, explorerFor } from "../lib/payment-net.js";

const [batch, outPath, ...files] = process.argv.slice(2);
if (!batch || !outPath) throw new Error("usage: run-report.ts <batch-prefix> <out.md> [jsonl...]");
const today = new Date().toISOString().slice(0, 10);
const logs = files.length ? files : [resolve(ROOT, "log", `${today}.jsonl`)];
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

const netName = (n?: string | null) =>
  n === SOLANA_MAINNET_CAIP2 ? "Solana mainnet" : n === BASE_MAINNET_CAIP2 ? "Base" : n?.startsWith("solana:Et") ? "Solana devnet" : n ?? "-";
const short = (s?: string | null, n = 10) => (s ? `${s.slice(0, n)}…` : "-");
const link = (net: string | undefined, tx?: string | null) => (tx ? `[${short(tx, 12)}](${explorerFor(net ?? "", tx)})` : "-");
const devLink = (tx?: string | null) => (tx ? `[${short(tx, 12)}](https://explorer.solana.com/tx/${tx}?cluster=devnet)` : "-");

type Out = {
  n: string; label: string; host: string; outcome: string; probe_verdict: string; probe_score: string; match: string;
  quotes: string[]; awarded: string; pay_net: string; amount: bigint; pay_tx: string | null; record_tx: string | null; wall: string; notes: string[];
  devnet_txs: string[]; landed: boolean;
};
const outs: Out[] = [];
for (const [scenario, rs] of byScenario) {
  const step = (s: string) => rs.filter((r) => r.step === s);
  const one = (s: string) => step(s).at(-1);
  const [n, ...rest] = scenario.slice(batch.length + 1).split("-");
  const label = rest.join("-");
  const q402 = step("catalog_402");
  const quotes = step("catalog_quote").map((q: any) =>
    `${q.host} ${q.price_usdc} USDC on ${netName(q.network)}${q.payable ? "" : " (not payable here)"}, Probe ${q.probe_score ?? "-"} / ${q.probe_verdict ?? q.probe_status ?? "-"}`);
  for (const q of q402.filter((x: any) => !x.ok)) quotes.push(`${q.url}: not quoted (${q.reason})`);
  const probe = q402.find((x: any) => x.probe)?.probe;
  const award = one("award");
  const sent = one("x402_payment_sent");
  const paidR = one("x402_paid");
  const dws = one("x402_delivered_without_settlement");
  const failed = one("x402_paid_request_failed");
  const ful = one("record_fulfillment");
  const rej = one("record_rejection");
  const cancel = one("cancel_rfq");
  const round = one("catalog_round");
  const ver = one("indexer_verification");
  const notes: string[] = [];
  let outcome = "-";
  if (round?.deferred) outcome = `deferred (${round.deferred})`;
  else if (ful) outcome = ful.outcome ?? (ful.recovered ? "recovered" : "fulfilled");
  else if (rej) outcome = rej.reason === "not_delivered" ? "not_delivered" : `rejected (${rej.reason})`;
  else if (cancel) outcome = step("catalog_quote").length ? "not paid (quote recorded only)" : "no quote (no payable 402)";
  else if (failed && !failed.landed_payment_tx) outcome = "purchase not completed (seller refused the payment, nothing landed)";
  else if (round) outcome = `error (exit ${round.exit})`;
  if (cancel) for (const e of cancel.excluded ?? []) notes.push(e.why);
  const rc = one("rerequest_check");
  if (rc) notes.push(rc.done ? `re-request check: HTTP ${rc.http_status}, same body ${rc.same_body}, charged again ${rc.charged_again}` : `re-request check skipped: ${rc.why}`);
  const rr = one("x402_rerequest");
  if (rr) notes.push(`re-request with the same payment header: HTTP ${rr.http_status}`);
  const receipt = one("delivery_receipt");
  if (receipt?.present) notes.push(`Delivery Receipt ${receipt.ok ? "verified" : "INVALID: " + receipt.problems.join("; ")}`);
  if (ver && !ver.verified && (ful || rej)) notes.push(`indexer: not verified (${ver.verification?.reason ?? "-"})`);
  if (failed) notes.push(`first paid call HTTP ${failed.http_status}`);
  const pv: string = probe?.verdict ?? (probe?.status === "scored" ? "no paid measurement" : probe?.status ?? "-");
  const ours = outcome === "fulfilled" || outcome === "recovered" ? "delivered" : outcome;
  const match = label.startsWith("mock") || !probe ? "-"
    : !sent ? "- (not bought)"
    : pv === "delivered" ? (ours === "delivered" ? "yes" : `no (Probe delivered, RFQ ${ours})`)
    : `Probe ${pv}, RFQ ${ours}`;
  const payTx = paidR?.payment_tx ?? failed?.landed_payment_tx ?? null;
  outs.push({
    n, label, host: q402[0]?.host ?? label, outcome, probe_verdict: pv, probe_score: String(probe?.score ?? "-"), match, quotes,
    awarded: award ? `${short(award.seller, 8)} ${award.price_usdc} USDC` : "-", pay_net: sent?.network ?? "", amount: sent ? BigInt(sent.amount) : 0n,
    pay_tx: payTx, record_tx: ful?.tx ?? rej?.tx ?? cancel?.tx ?? null, wall: round?.wall_seconds !== undefined ? `${round.wall_seconds}s` : "-", notes,
    devnet_txs: [one("post_rfq")?.tx, ...step("catalog_quote").map((q: any) => q.tx), award?.tx, ful?.tx ?? rej?.tx ?? cancel?.tx].filter(Boolean),
    landed: !!payTx && !dws,
  });
}
outs.sort((a, b) => a.n.localeCompare(b.n));

// summary
const mainnet = outs.filter((o) => o.pay_net === SOLANA_MAINNET_CAIP2 || o.pay_net === BASE_MAINNET_CAIP2);
const sum = (xs: Out[]) => xs.reduce((s, o) => s + o.amount, 0n);
const count = (pred: (o: Out) => boolean) => outs.filter(pred).length;
const lines: string[] = [];
lines.push(`# Run ${batch}`, "");
lines.push("Records on Solana devnet (program `7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp`); payments in mainnet USDC (Solana / Base) to real catalog sellers; the mock seller is paid in devnet USDC.", "");
lines.push("## Summary", "");
lines.push("| | count | USDC |", "|---|---:|---:|");
for (const [name, net] of [["Solana mainnet", SOLANA_MAINNET_CAIP2], ["Base", BASE_MAINNET_CAIP2]] as const) {
  const xs = mainnet.filter((o) => o.pay_net === net);
  lines.push(`| payments signed on ${name} | ${xs.length} | ${fmtUsdc(sum(xs))} |`);
  const landed = xs.filter((o) => o.landed);
  lines.push(`| payments landed on ${name} | ${landed.length} | ${fmtUsdc(sum(landed))} |`);
}
lines.push(`| **mainnet total signed** | **${mainnet.length}** | **${fmtUsdc(sum(mainnet))}** |`);
const dev = outs.filter((o) => o.pay_net && !mainnet.includes(o));
lines.push(`| devnet (mock seller) | ${dev.length} | ${fmtUsdc(sum(dev))} (devnet USDC) |`, "");
lines.push("| outcome | RFQs |", "|---|---:|");
for (const k of ["fulfilled", "recovered", "not_delivered", "delivered_without_settlement", "rejected", "purchase not completed", "not paid (quote recorded only)", "no quote", "deferred", "error"])
  lines.push(`| ${k} | ${count((o) => o.outcome.startsWith(k))} |`);
lines.push(`| **RFQs** | **${outs.length}** |`, "");
const cmp = outs.filter((o) => o.match === "yes" || o.match.startsWith("no"));
lines.push(`Probe agreement (bought hosts whose latest Probe paid verdict was 納品): ${cmp.filter((o) => o.match === "yes").length} of ${cmp.length} delivered for the RFQ buyer too.`, "");

lines.push("## Per RFQ", "");
lines.push("| # | host | outcome | Probe verdict / score | matches Probe | paid on | amount | payment tx | devnet record tx | time |", "|---|---|---|---|---|---|---:|---|---|---:|");
for (const o of outs)
  lines.push(`| ${o.n} | ${o.host} | ${o.outcome} | ${o.probe_verdict} / ${o.probe_score} | ${o.match} | ${netName(o.pay_net || null)} | ${o.amount ? fmtUsdc(o.amount) : "-"} | ${link(o.pay_net, o.pay_tx)} | ${devLink(o.record_tx)} | ${o.wall} |`);
lines.push("");
lines.push("## Details", "");
for (const o of outs) {
  lines.push(`### ${o.n} ${o.label}`, "");
  lines.push(`- quotes: ${o.quotes.length ? "" : "none"}`);
  for (const q of o.quotes) lines.push(`  - ${q}`);
  lines.push(`- awarded: ${o.awarded}`);
  lines.push(`- payment: ${o.pay_tx ? `${netName(o.pay_net)} ${o.pay_tx}` : "none"}`);
  lines.push(`- devnet records: ${o.devnet_txs.map((t) => `\`${t}\``).join(", ") || "-"}`);
  lines.push(`- outcome: ${o.outcome}; time ${o.wall}`);
  for (const nn of o.notes) lines.push(`- ${nn}`);
  lines.push("");
}
writeFileSync(resolve(ROOT, outPath), lines.join("\n"));
console.log(`wrote ${outPath}: ${outs.length} RFQ(s), mainnet signed ${fmtUsdc(sum(mainnet))} USDC`);
