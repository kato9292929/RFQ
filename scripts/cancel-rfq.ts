// Cancel an Open RFQ owned by the buyer key: npx tsx scripts/cancel-rfq.ts <rfq> [reason]
import { PublicKey } from "@solana/web3.js";
import { appendLog, env, explorerTx, loadKeypair, program } from "../lib/common.js";
const kp = loadKeypair(env("BUYER_KEYPAIR", ".keys/buyer.json"));
const rfq = new PublicKey(process.argv[2]);
const sig = await program(kp).methods.cancelRfq().accountsPartial({ buyer: kp.publicKey, rfq }).rpc();
appendLog({ actor: "buyer", step: "cancel_rfq", rfq: rfq.toBase58(), reason: process.argv[3] ?? "", tx: sig, explorer: explorerTx(sig) });
console.log(sig);
