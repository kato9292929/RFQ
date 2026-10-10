// Create the Config PDA (authority = deployer). Idempotent.
import { PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { appendLog, connection, env, explorerTx, loadKeypair, pdas, program } from "../lib/common.js";

const authority = loadKeypair(env("DEPLOYER_KEYPAIR", ".keys/deployer.json"));
const treasuryOwner = loadKeypair(env("TREASURY_OWNER_KEYPAIR", ".keys/treasury_owner.json"));
const mint = new PublicKey(env("USDC_MINT"));
const feeBps = Number(env("FEE_BPS", "100"));
const prog = program(authority);
const conn = connection();
const config = pdas(prog.programId).config();

const existing = await prog.account.config.fetchNullable(config);
if (existing) {
  console.log(JSON.stringify({ config: config.toBase58(), treasury: existing.treasury.toBase58(), fee_bps: existing.feeBps, usdc_mint: existing.usdcMint.toBase58(), existed: true }));
  process.exit(0);
}
const treasury = (await getOrCreateAssociatedTokenAccount(conn, authority, mint, treasuryOwner.publicKey)).address;
const sig = await prog.methods
  .initialize(feeBps, mint, treasury)
  .accountsPartial({ authority: authority.publicKey, usdcMint: mint, treasury })
  .rpc();
appendLog({ actor: "deployer", step: "initialize", program_id: prog.programId.toBase58(), config: config.toBase58(), treasury: treasury.toBase58(), treasury_owner: treasuryOwner.publicKey.toBase58(), usdc_mint: mint.toBase58(), fee_bps: feeBps, tx: sig, explorer: explorerTx(sig) });
console.log(JSON.stringify({ config: config.toBase58(), treasury: treasury.toBase58(), fee_bps: feeBps, usdc_mint: mint.toBase58(), tx: sig }));
