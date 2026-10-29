// x402 Seller Probe (probe.x402jp.com): drop quotes whose seller host scores below the
// spec's `min_probe_score`. A host the Probe has not scored is not "below" it, and an
// unreachable Probe API says nothing either: both keep the quote and are logged
// (`probe_unscored` / `probe_unavailable`), and selection proceeds as before.

export const PROBE_URL = () => process.env.PROBE_URL || "https://probe.x402jp.com";

/** Same host key as the Probe: lowercase hostname, no port, no leading "www.". */
export function probeHost(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function checkMinProbeScore(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`min_probe_score must be a number in 0..100, got ${JSON.stringify(v)}`);
  return v;
}

/** Seller Probe's verdict on one of its own paid purchases. */
export type ProbeVerdict = "delivered" | "not_delivered" | "delivered_without_settlement" | "request_rejected" | "failed";

/** The Probe's latest paid measurement of a host (its own x402 purchase). */
export type ProbePaid = { ts: string; url: string; network: string | null; amount: string | null; verdict: ProbeVerdict; tx: string | null };

export type ProbeLookup =
  | {
      status: "scored"; host: string; score: number | null; coverage: string | null; last_paid: ProbePaid | null;
      verdict: ProbeVerdict | null; delivered: boolean; requires_input: string | null;
    }
  | { status: "unscored"; host: string }
  | { status: "unavailable"; host: string | null; error: string };

/** 納品 / 払ったのに届かない / 送金なしで届いた / 購入不成立 / 失敗 */
export function probeVerdict(h: any): ProbeVerdict | null {
  if (!h || h.dry_run || (h.outcome == null && h.delivered == null)) return null; // signed but not sent
  if (h.outcome === "delivered" && h.onchain_ok !== false) return "delivered";
  if (h.delivered === true && h.onchain_ok === false) return "delivered_without_settlement";
  if (h.outcome === "not_delivered") return "not_delivered";
  if (h.outcome === "request_rejected") return "request_rejected";
  return "failed";
}

// A rejection that says an input was missing (the Probe buys with a bare GET).
const INPUT_HINT = /missing|required|param|invalid_input|invalid_request|method_not_allowed|use POST|takes POST/i;

const cache = new Map<string, Promise<ProbeLookup>>();
let requiresInputList: Promise<Map<string, string>> | null = null;

/** The Probe's list of hosts it did not buy from because they need input (from GET /scores). */
function requiresInput(timeoutMs: number): Promise<Map<string, string>> {
  requiresInputList ??= (async () => {
    try {
      const r = await fetch(`${PROBE_URL()}/scores`, { signal: AbortSignal.timeout(Math.max(timeoutMs, 60_000)) });
      if (!r.ok) return new Map();
      const d: any = await r.json();
      return new Map((d?.paid_targets?.requires_input ?? []).map((x: any) => [String(x.host).toLowerCase(), String(x.reason)]));
    } catch {
      return new Map();
    }
  })();
  return requiresInputList;
}

/** GET /scores/:host once per host per process. */
export function lookupProbe(endpointUri: string, timeoutMs = 5000): Promise<ProbeLookup> {
  const host = probeHost(endpointUri);
  if (!host) return Promise.resolve({ status: "unavailable", host: null, error: `cannot parse host of ${endpointUri}` });
  if (!cache.has(host)) cache.set(host, fetchProbe(host, timeoutMs));
  return cache.get(host)!;
}

async function fetchProbe(host: string, timeoutMs: number): Promise<ProbeLookup> {
  try {
    const r = await fetch(`${PROBE_URL()}/scores/${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 404) return { status: "unscored", host };
    if (!r.ok) return { status: "unavailable", host, error: `HTTP ${r.status}` };
    const d: any = await r.json();
    const paid = (Array.isArray(d.history) ? d.history : [])
      .filter((h: any) => h?.kind === "paid" && probeVerdict(h) !== null)
      .sort((a: any, b: any) => String(b.ts).localeCompare(String(a.ts)))[0];
    const last_paid: ProbePaid | null = paid
      ? { ts: paid.ts, url: paid.url, network: paid.network ?? null, amount: paid.amount ?? null, verdict: probeVerdict(paid)!, tx: paid.tx ?? null }
      : null;
    const listed = (await requiresInput(timeoutMs)).get(host) ?? null;
    const rej = d.last_rejection;
    const observed = rej && INPUT_HINT.test(`${rej.http_status === 405 ? "method_not_allowed " : ""}${rej.error ?? ""}`)
      ? `turned away for missing input (HTTP ${rej.http_status} at ${rej.ts})` : null;
    return {
      status: "scored", host, score: typeof d.score === "number" ? d.score : null, coverage: d.coverage ?? null,
      last_paid, verdict: last_paid?.verdict ?? null, delivered: last_paid?.verdict === "delivered", requires_input: listed ?? observed,
    };
  } catch (e: any) {
    return { status: "unavailable", host, error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
  }
}

/** Why a host is not paid (null = payable on Probe grounds). Own hosts are decided by the caller. */
export function probeNoPayReason(l: ProbeLookup): string | null {
  if (l.status === "unavailable") return `Seller Probe did not answer (${l.error})`;
  if (l.status === "unscored") return "not measured by Seller Probe";
  if (l.requires_input) return `Seller Probe: requires input (${l.requires_input})`;
  if (!l.last_paid) return "Seller Probe has no paid measurement";
  if (l.verdict !== "delivered") return `Seller Probe latest paid verdict: ${l.verdict}`;
  return null;
}

/**
 * Pure: which quotes stay. Only a host with a score below `min` is excluded;
 * unscored hosts and an unavailable Probe never exclude.
 */
export function applyProbeFilter<Q extends { pubkey: string; seller: string }>(
  quotes: Q[], lookups: Map<string, ProbeLookup>, min: number,
): {
  kept: Q[];
  excluded: { quote: string; seller: string; why: string }[];
  unscored: { quote: string; host: string }[];
  unavailable: { quote: string; host: string | null; error: string }[];
} {
  const kept: Q[] = [];
  const excluded: { quote: string; seller: string; why: string }[] = [];
  const unscored: { quote: string; host: string }[] = [];
  const unavailable: { quote: string; host: string | null; error: string }[] = [];
  for (const q of quotes) {
    const l = lookups.get(q.pubkey);
    if (!l || l.status === "unavailable") {
      unavailable.push({ quote: q.pubkey, host: l?.host ?? null, error: l && l.status === "unavailable" ? l.error : "no lookup" });
      kept.push(q);
    } else if (l.status === "unscored" || l.score === null) {
      // No number from the Probe (not measured, or measured without a score): not "below" min.
      unscored.push({ quote: q.pubkey, host: l.host });
      kept.push(q);
    } else if (l.score < min) {
      excluded.push({ quote: q.pubkey, seller: q.seller, why: `probe_score ${l.score} (${l.coverage}) < min_probe_score=${min} for ${l.host}` });
    } else kept.push(q);
  }
  return { kept, excluded, unscored, unavailable };
}
