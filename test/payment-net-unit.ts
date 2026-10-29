// Checks for lib/payment-net.ts and lib/receipt.ts: npx tsx test/payment-net-unit.ts
// With MAINNET_RPC_URL set, also checks a real mainnet USDC transfer (a Seller Probe purchase).
import assert from "node:assert/strict";
import { Connection, Keypair } from "@solana/web3.js";
import {
  BASE_MAINNET_CAIP2, BASE_USDC, MAINNET_USDC_MINT, SOLANA_MAINNET_CAIP2, baseRpcUrl, checkUsdcTransfer, decodePaymentRef, encodePaymentRef, loadPayers,
  memoInstruction, parseRecordMemo,
} from "../lib/payment-net.js";
import { checkEvmTransfer, evmClient } from "../lib/evm-pay.js";
import { checkReceipt, encodeReceipt, makeReceipt, readReceipt } from "../lib/receipt.js";

// memo round trip
const ix = memoInstruction({ pay_net: SOLANA_MAINNET_CAIP2, payer: "P", receipt: "ok", recovered: true, first_status: 503 });
assert.deepEqual(parseRecordMemo(`[12] ${ix.data.toString("utf8")}`), { pay_net: SOLANA_MAINNET_CAIP2, payer: "P", receipt: "ok", recovered: true, first_status: 503 });
assert.equal(parseRecordMemo('{"other":1}'), null);
assert.ok(ix.data.length < 400);

// mainnet payer needs CONFIRM_MAINNET=yes, MAINNET_RPC_URL and MAINNET_BUYER_KEYPAIR
const kp = Keypair.generate();
const saved = { ...process.env };
process.env.MAINNET_BUYER_KEYPAIR = JSON.stringify(Array.from(Keypair.generate().secretKey));
process.env.MAINNET_RPC_URL = "http://127.0.0.1:1";
delete process.env.CONFIRM_MAINNET;
assert.equal((await loadPayers(kp, kp.publicKey)).payers.has(SOLANA_MAINNET_CAIP2), false, "no mainnet without CONFIRM_MAINNET=yes");
process.env.CONFIRM_MAINNET = "yes";
assert.equal((await loadPayers(kp, kp.publicKey)).payers.has(SOLANA_MAINNET_CAIP2), true);
Object.assign(process.env, saved);
for (const k of ["MAINNET_BUYER_KEYPAIR", "CONFIRM_MAINNET"]) if (!(k in saved)) delete process.env[k];

// payment refs in the 64-byte payment_sig field
const evmHash = "0x2714bd5b820a34ed9bbb423b7464b0da8ea49dd644942c98ceb4e655469f5261";
assert.equal(decodePaymentRef(BASE_MAINNET_CAIP2, encodePaymentRef(BASE_MAINNET_CAIP2, evmHash)), evmHash);
const solSig = "4z55agAXxc3bJcVfqeyVVWiR4VJq659JAr3nGv3TmQDqxqYRxzU91xFaNqoUeakcTA7kLNXeYSH6bCCNdzkLB212";
assert.equal(decodePaymentRef(SOLANA_MAINNET_CAIP2, encodePaymentRef(SOLANA_MAINNET_CAIP2, solSig)), solSig);
assert.equal(decodePaymentRef(SOLANA_MAINNET_CAIP2, encodePaymentRef(SOLANA_MAINNET_CAIP2, null)), null, "no payment → zeros → null");

// Base payer needs CONFIRM_MAINNET=yes and MAINNET_BUYER_BASE_KEY
process.env.MAINNET_BUYER_BASE_KEY = "0x" + "11".repeat(32);
process.env.CONFIRM_MAINNET = "yes";
const evmP = (await loadPayers(kp, kp.publicKey)).payers.get(BASE_MAINNET_CAIP2);
assert.equal(evmP?.kind, "evm");
assert.equal(evmP?.address, "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
delete process.env.CONFIRM_MAINNET;
assert.equal((await loadPayers(kp, kp.publicKey)).payers.has(BASE_MAINNET_CAIP2), false);
delete process.env.MAINNET_BUYER_BASE_KEY;

// receipt: valid, tampered body, wrong payment
const seller = Keypair.generate();
const body = Buffer.from('{"series":[1,2,3]}');
const r = makeReceipt(seller, { payment_id: "TX1", network: "n", resource: "u", body });
const back = readReceipt((h) => (h.toLowerCase() === "delivery-receipt" ? encodeReceipt(r) : null));
const f = { body, payment_id: "TX1", network: "n", pay_to: seller.publicKey.toBase58() };
assert.equal(checkReceipt(back, f).ok, true);
assert.equal(checkReceipt(back, f).signer_is_pay_to, true);
assert.equal(checkReceipt(back, { ...f, body: Buffer.from("{}") }).ok, false);
assert.equal(checkReceipt(back, { ...f, payment_id: "TX2" }).ok, false);
assert.equal(checkReceipt({ ...r, signer: Keypair.generate().publicKey.toBase58() }, f).ok, false, "another key cannot claim the signature");
assert.equal(checkReceipt(null, f).present, false);

if (process.env.MAINNET_RPC_URL) {
  // Seller Probe's paid measurement of surf.cascade.fyi on 2026-10-28 (0.001 USDC).
  const c = new Connection(process.env.MAINNET_RPC_URL, "confirmed");
  const sig = "4z55agAXxc3bJcVfqeyVVWiR4VJq659JAr3nGv3TmQDqxqYRxzU91xFaNqoUeakcTA7kLNXeYSH6bCCNdzkLB212";
  const tx = await c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const payerOwner = tx!.meta!.preTokenBalances!.find((b) => b.mint === MAINNET_USDC_MINT && b.owner !== "9MkM5Ra48KFcSv9HDQ8sb3C3r5HjouEwGQ6sp1cx1vde")!.owner!;
  const base = { mint: MAINNET_USDC_MINT, buyer: payerOwner, seller: "9MkM5Ra48KFcSv9HDQ8sb3C3r5HjouEwGQ6sp1cx1vde", amount: 1000n, network: SOLANA_MAINNET_CAIP2 };
  assert.equal((await checkUsdcTransfer(c, sig, base)).ok, true, "real mainnet transfer verifies");
  assert.equal((await checkUsdcTransfer(c, sig, { ...base, amount: 2000n })).ok, false, "wrong amount fails");
  assert.equal((await checkUsdcTransfer(c, sig, { ...base, buyer: kp.publicKey.toBase58() })).ok, false, "wrong sender fails");
  assert.equal((await checkUsdcTransfer(c, sig, { ...base, seller: kp.publicKey.toBase58() })).ok, false, "wrong payTo fails");
  console.log("mainnet transfer checks passed");
}
if (process.env.CHECK_BASE !== "0") {
  // Seller Probe's paid measurement of apexrunner.ai on Base, 2026-10-28 (0.007 USDC).
  const r = await evmClient(baseRpcUrl()).getTransactionReceipt({ hash: evmHash });
  const t = r.logs.find((l) => l.address.toLowerCase() === BASE_USDC.toLowerCase() && l.topics.length === 3)!;
  const from = `0x${t.topics[1]!.slice(26)}`;
  const base = { usdc: BASE_USDC, buyer: from, seller: "0x8D0663BBb967ebF1c047405A888DDf865f3E8854", amount: 7000n, network: BASE_MAINNET_CAIP2 };
  assert.equal((await checkEvmTransfer(baseRpcUrl(), evmHash, base)).ok, true, "real Base transfer verifies");
  assert.equal((await checkEvmTransfer(baseRpcUrl(), evmHash, { ...base, amount: 7001n })).ok, false, "wrong amount fails");
  assert.equal((await checkEvmTransfer(baseRpcUrl(), evmHash, { ...base, buyer: "0x0000000000000000000000000000000000000001" })).ok, false, "wrong sender fails");
  assert.equal((await checkEvmTransfer(baseRpcUrl(), evmHash, { ...base, seller: "0x0000000000000000000000000000000000000001" })).ok, false, "wrong payTo fails");
  console.log("Base transfer checks passed");
}
console.log("payment-net checks passed");

// Base payment payload (signed, never sent): EIP-712 fill only for Circle USDC, EIP-3009 fields,
// signature recovers to the buyer.
{
  const { fillBaseEip712, BASE_USDC: USDC } = await import("../lib/payment-net.js");
  const { evmScheme, evmAuthorizationNonce } = await import("../lib/evm-pay.js");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const { verifyTypedData } = await import("viem");
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  const req = { scheme: "exact", network: "eip155:8453", amount: "7000", asset: USDC, payTo: "0x8D0663BBb967ebF1c047405A888DDf865f3E8854", maxTimeoutSeconds: 300, extra: {} as any };
  const other = { ...req, asset: "0x0000000000000000000000000000000000000abc", extra: {} as any };
  assert.equal(fillBaseEip712([req, other]).length, 1);
  assert.deepEqual([req.extra.name, req.extra.version], ["USD Coin", "2"]);
  assert.equal(other.extra.name, undefined, "unknown asset is not filled");
  const out: any = await evmScheme({ kind: "evm", network: "eip155:8453", address: acct.address, privateKey: pk, rpcUrl: "", usdc: USDC as any }).createPaymentPayload(2, req as any);
  const auth = out.payload.authorization;
  assert.equal(auth.from.toLowerCase(), acct.address.toLowerCase());
  assert.equal(auth.to.toLowerCase(), req.payTo.toLowerCase());
  assert.equal(String(auth.value), "7000");
  assert.equal(evmAuthorizationNonce({ payload: out.payload }), auth.nonce);
  const ok = await verifyTypedData({
    address: acct.address,
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC as any },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
    signature: out.payload.signature,
  });
  assert.equal(ok, true, "EIP-3009 signature recovers to the buyer under Circle USDC's domain");
  console.log("Base payload checks passed");
}
