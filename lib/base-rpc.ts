// Base JSON-RPC with failover: BASE_RPC_URL first (a dedicated RPC), then public ones in order.
// Rate limits (429, "limit"), 5xx and network errors are retried with a growing pause, then the
// next RPC is tried. Only reads go through here; nothing is ever (re)sent.
export const PUBLIC_BASE_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"];

export function baseRpcUrls(): string[] {
  const list = (process.env.BASE_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const first = process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : [];
  return [...new Set([...first, ...(list.length ? list : PUBLIC_BASE_RPCS)])];
}

/** Host only: never log an API key that sits in a URL path or query. */
export const rpcLabel = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

export class RpcUnavailable extends Error {
  constructor(public errors: string[]) {
    super(`all Base RPCs failed: ${errors.join("; ")}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const transient = (status: number, msg: string) => status === 429 || status >= 500 || /limit|rate|too many|timeout|busy|unavailable/i.test(msg);

export type RpcOpts = { urls?: string[]; attempts?: number; delayMs?: number; timeoutMs?: number };

/** One JSON-RPC call, with retries per RPC and failover across RPCs. Returns the result and the RPC used. */
export async function baseRpc<T = any>(method: string, params: unknown[], o: RpcOpts = {}): Promise<{ result: T; rpc: string }> {
  const urls = o.urls ?? baseRpcUrls();
  const attempts = o.attempts ?? 3;
  const delay = o.delayMs ?? 1500;
  const errors: string[] = [];
  for (const url of urls) {
    for (let i = 0; i < attempts; i++) {
      let status = 0;
      let msg = "";
      try {
        const r = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
        });
        status = r.status;
        const text = await r.text();
        let j: any;
        try {
          j = JSON.parse(text);
        } catch {
          msg = `HTTP ${r.status}: ${text.slice(0, 80)}`;
        }
        if (j && !j.error && r.ok) return { result: j.result as T, rpc: rpcLabel(url) };
        msg ||= j?.error ? `${j.error.code}: ${j.error.message}` : `HTTP ${r.status}`;
        if (!transient(status, msg)) { errors.push(`${rpcLabel(url)} ${msg}`); break; } // not worth retrying here
      } catch (e: any) {
        msg = e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e);
      }
      errors.push(`${rpcLabel(url)} ${msg}`);
      if (i < attempts - 1) await sleep(delay * (i + 1));
    }
  }
  throw new RpcUnavailable(errors);
}
