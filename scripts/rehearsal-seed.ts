// Upgrade rehearsal: create pre-upgrade state using only the original instructions
// (post_rfq, submit_quote, award, record_fulfillment).
import anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadKeypair, pdas, program, sha256 } from "../lib/common.js";
const { BN } = anchor;
const buyer = loadKeypair(".keys/buyer.json");
const seller = loadKeypair(".keys/seller1.json");
const pb = program(buyer);
const ps = program(seller);
const P = pdas(pb.programId);
const cfg = await pb.account.config.fetch(P.config());
const nonce = BigInt(Date.now());
const rfq = P.rfq(buyer.publicKey, nonce);
const now = Math.floor(Date.now() / 1000);
await pb.methods.postRfq(new BN(nonce.toString()), [...sha256("{}")], "http://x/specs/old", new BN(100_000), new BN(now + 30))
  .accountsPartial({ buyer: buyer.publicKey }).rpc();
const uri = "http://x/q/old";
await ps.methods.submitQuote(new BN(40_000), [...sha256(uri)], uri, new BN(now + 3600)).accountsPartial({ seller: seller.publicKey, rfq }).rpc();
const quote = P.quote(rfq, seller.publicKey);
await pb.methods.award().accountsPartial({ buyer: buyer.publicKey, rfq, quote, buyerUsdc: getAssociatedTokenAddressSync(cfg.usdcMint, buyer.publicKey), treasury: cfg.treasury, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
await pb.methods.recordFulfillment([...Buffer.alloc(64, 5)], [...sha256("old")]).accountsPartial({ buyer: buyer.publicKey, rfq, quote }).rpc();
console.log(JSON.stringify({ rfq: rfq.toBase58(), quote: quote.toBase58() }));
