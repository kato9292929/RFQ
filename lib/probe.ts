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

export type ProbeLookup =
  | { status: "scored"; host: string; score: number | null; coverage: string | null }
  | { status: "unscored"; host: string }
  | { status: "unavailable"; host: string | null; error: string };

export async function lookupProbe(endpointUri: string, timeoutMs = 5000): Promise<ProbeLookup> {
  const host = probeHost(endpointUri);
  if (!host) return { status: "unavailable", host: null, error: `cannot parse host of ${endpointUri}` };
  try {
    const r = await fetch(`${PROBE_URL()}/scores/${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 404) return { status: "unscored", host };
    if (!r.ok) return { status: "unavailable", host, error: `HTTP ${r.status}` };
    const d: any = await r.json();
    return { status: "scored", host, score: typeof d.score === "number" ? d.score : null, coverage: d.coverage ?? null };
  } catch (e: any) {
    return { status: "unavailable", host, error: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
  }
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
