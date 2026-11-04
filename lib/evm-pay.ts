// Base (EVM) side of catalog payments: x402 exact = EIP-3009 transferWithAuthorization signed by
// the buyer, submitted by the seller's facilitator (the buyer holds no ETH).
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes, pad, parseAbiItem, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { sleep } from "./common.js";
import type { EvmPayer, TransferCheck } from "./payment-net.js";
import { RpcUnavailable, baseRpc, type RpcOpts } from "./base-rpc.js";

export const evmClient = (rpcUrl: string) => createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 20_000 }) });
export const evmScheme = (p: EvmPayer) => new ExactEvmScheme(privateKeyToAccount(p.privateKey));

/** The EIP-3009 nonce in an x402 exact EVM payload: what identifies this payment on chain. */
export function evmAuthorizationNonce(payload: any): Hex {
  const n = payload?.payload?.authorization?.nonce;
  if (typeof n !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(n)) throw new Error("x402 EVM payload has no EIP-3009 authorization nonce");
  return n as Hex;
}

const AUTH_USED = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const AUTH_STATE = parseAbiItem("function authorizationState(address authorizer, bytes32 nonce) view returns (bool)");
const BALANCE_OF = parseAbiItem("function balanceOf(address) view returns (uint256)");

export type LandedEvm =
  | { status: "landed"; hash: string; ok: boolean; rpc: string }
  | { status: "not_landed"; rpc: string }
  | { status: "unknown"; errors: string[] }; // could not tell: no Base RPC answered

/**
 * Did our authorization land? USDC's authorizationState(authorizer, nonce) — one eth_call — and,
 * once it is used, the tx through AuthorizationUsed logs in small block windows. Reads go through
 * lib/base-rpc.ts (BASE_RPC_URL, then public RPCs). If no RPC can answer, the result is "unknown":
 * the payment is NOT treated as failed and nothing is re-sent.
 */
export async function findLandedEvm(p: EvmPayer, nonce: Hex, timeoutMs = 90_000, o: RpcOpts = {}): Promise<LandedEvm> {
  const until = Date.now() + timeoutMs;
  let lastRpc = "";
  let errors: string[] = [];
  let answered = false;
  while (Date.now() < until) {
    let used = false;
    try {
      const data = encodeFunctionData({ abi: [AUTH_STATE], functionName: "authorizationState", args: [p.address as Hex, nonce] });
      const r = await baseRpc<string>("eth_call", [{ to: p.usdc, data }, "latest"], o);
      used = BigInt(r.result || "0x0") !== 0n;
      lastRpc = r.rpc;
      answered = true;
    } catch (e: any) {
      errors = e instanceof RpcUnavailable ? e.errors : [String(e?.message ?? e)];
    }
    if (used) {
      try {
        const head = BigInt((await baseRpc<string>("eth_blockNumber", [], o)).result);
        for (let to = head; to > head - 3000n; to -= 500n) {
          const r = await baseRpc<any[]>("eth_getLogs", [{
            address: p.usdc, fromBlock: `0x${(to - 499n).toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [AUTH_USED, pad(p.address as Hex), nonce],
          }], o);
          if (r.result.length) {
            const hash = r.result[0].transactionHash;
            const rc = await baseRpc<any>("eth_getTransactionReceipt", [hash], o);
            return { status: "landed", hash, ok: rc.result?.status === "0x1", rpc: rc.rpc };
          }
        }
      } catch {
        /* the authorization is used; only the tx lookup failed */
      }
      return { status: "landed", hash: "", ok: true, rpc: lastRpc }; // used, tx not found (yet)
    }
    await sleep(o.delayMs !== undefined ? Math.min(o.delayMs, 4000) : 4000);
  }
  return answered ? { status: "not_landed", rpc: lastRpc } : { status: "unknown", errors };
}

/** Did tx `hash` move exactly `amount` USDC from `buyer` to `seller` (and nothing else from buyer)? */
export async function checkEvmTransfer(
  _rpcUrl: string | null, hash: string, f: { usdc: string; buyer: string; seller: string; amount: bigint; network: string }, o: RpcOpts = {},
): Promise<TransferCheck> {
  let r: any;
  let rpc = "";
  try {
    const x = await baseRpc<any>("eth_getTransactionReceipt", [hash], o);
    r = x.result;
    rpc = x.rpc;
  } catch (e: any) {
    return { ok: false, reason: `settlement_unknown: ${e?.message ?? e}`, details: { network: f.network } };
  }
  if (!r) return { ok: false, reason: "transaction not found", details: { network: f.network, rpc } };
  if (r.status !== "0x1") return { ok: false, reason: "transaction reverted", details: { network: f.network, rpc } };
  let sent = 0n;
  let received = 0n;
  const lc = (s: string) => s.toLowerCase();
  for (const l of r.logs ?? []) {
    if (lc(l.address) !== lc(f.usdc) || l.topics?.[0] !== TRANSFER_TOPIC) continue;
    const from = `0x${l.topics[1].slice(26)}`;
    const to = `0x${l.topics[2].slice(26)}`;
    const v = BigInt(l.data);
    if (lc(from) === lc(f.buyer)) sent += v;
    if (lc(from) === lc(f.buyer) && lc(to) === lc(f.seller)) received += v;
  }
  const details = {
    network: f.network, mint: f.usdc, seller: f.seller, buyer: f.buyer, expected_amount: f.amount.toString(),
    seller_received: received.toString(), buyer_sent: sent.toString(), block: BigInt(r.blockNumber).toString(), rpc,
  };
  if (received !== f.amount) return { ok: false, reason: "seller USDC delta does not equal quote.price", details };
  if (sent !== f.amount) return { ok: false, reason: "buyer USDC delta does not equal quote.price", details };
  return { ok: true, reason: `USDC transfer buyer→seller of quote.price confirmed on ${f.network}`, details };
}

export async function evmUsdcBalance(p: EvmPayer, o: RpcOpts = {}): Promise<bigint> {
  const data = encodeFunctionData({ abi: [BALANCE_OF], functionName: "balanceOf", args: [p.address as Hex] });
  return BigInt((await baseRpc<string>("eth_call", [{ to: p.usdc, data }, "latest"], o)).result);
}
