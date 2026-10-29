// Base (EVM) side of catalog payments: x402 exact = EIP-3009 transferWithAuthorization signed by
// the buyer, submitted by the seller's facilitator (the buyer holds no ETH).
import { createPublicClient, http, keccak256, toBytes, pad, parseAbiItem, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { sleep } from "./common.js";
import type { EvmPayer, TransferCheck } from "./payment-net.js";

export const evmClient = (rpcUrl: string) => createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 20_000 }) });
export const evmScheme = (p: EvmPayer) => new ExactEvmScheme(privateKeyToAccount(p.privateKey));

/** The EIP-3009 nonce in an x402 exact EVM payload: what identifies this payment on chain. */
export function evmAuthorizationNonce(payload: any): Hex {
  const n = payload?.payload?.authorization?.nonce;
  if (typeof n !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(n)) throw new Error("x402 EVM payload has no EIP-3009 authorization nonce");
  return n as Hex;
}

const AUTH_USED = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));

/** Find the tx that used our authorization (USDC emits AuthorizationUsed(authorizer, nonce)). */
export async function findLandedEvm(p: EvmPayer, nonce: Hex, timeoutMs = 90_000): Promise<{ hash: string; ok: boolean } | null> {
  const c = evmClient(p.rpcUrl);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const latest = await c.getBlockNumber();
    const logs = await c.request({
      method: "eth_getLogs",
      params: [{ address: p.usdc, fromBlock: `0x${(latest - 1800n).toString(16)}`, toBlock: "latest", topics: [AUTH_USED, pad(p.address as Hex), nonce] }],
    }) as any[];
    if (logs.length) {
      const r = await c.getTransactionReceipt({ hash: logs[0].transactionHash });
      return { hash: logs[0].transactionHash, ok: r.status === "success" };
    }
    await sleep(4000);
  }
  return null;
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Did tx `hash` move exactly `amount` USDC from `buyer` to `seller` (and nothing else from buyer)? */
export async function checkEvmTransfer(rpcUrl: string, hash: string, f: { usdc: string; buyer: string; seller: string; amount: bigint; network: string }): Promise<TransferCheck> {
  const c = evmClient(rpcUrl);
  let r;
  try {
    r = await c.getTransactionReceipt({ hash: hash as Hex });
  } catch {
    return { ok: false, reason: "transaction not found", details: { network: f.network } };
  }
  if (r.status !== "success") return { ok: false, reason: "transaction reverted", details: { network: f.network } };
  const topic0 = keccak256(toBytes("Transfer(address,address,uint256)"));
  let sent = 0n;
  let received = 0n;
  const lc = (s: string) => s.toLowerCase();
  for (const l of r.logs) {
    if (lc(l.address) !== lc(f.usdc) || l.topics[0] !== topic0) continue;
    const from = `0x${l.topics[1]!.slice(26)}`;
    const to = `0x${l.topics[2]!.slice(26)}`;
    const v = BigInt(l.data);
    if (lc(from) === lc(f.buyer)) sent += v;
    if (lc(from) === lc(f.buyer) && lc(to) === lc(f.seller)) received += v;
  }
  const details = {
    network: f.network, mint: f.usdc, seller: f.seller, buyer: f.buyer, expected_amount: f.amount.toString(),
    seller_received: received.toString(), buyer_sent: sent.toString(), block: r.blockNumber.toString(), event: TRANSFER.name,
  };
  if (received !== f.amount) return { ok: false, reason: "seller USDC delta does not equal quote.price", details };
  if (sent !== f.amount) return { ok: false, reason: "buyer USDC delta does not equal quote.price", details };
  return { ok: true, reason: `USDC transfer buyer→seller of quote.price confirmed on ${f.network}`, details };
}

export async function evmUsdcBalance(p: EvmPayer): Promise<bigint> {
  return evmClient(p.rpcUrl).readContract({
    address: p.usdc, abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")], functionName: "balanceOf", args: [p.address as Hex],
  });
}
