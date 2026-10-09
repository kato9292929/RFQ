// Local validator only: fund keys with SOL, create a 6-decimal test "USDC" mint and
// give the buyer some. Prints the mint address.
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { CLUSTER, connection, loadKeypair } from "../lib/common.js";

if (CLUSTER() !== "localnet") throw new Error("localnet-setup is for CLUSTER=localnet only");
const conn = connection();
const names = ["deployer", "buyer", "seller1", "seller2", "treasury_owner", "facilitator"];
for (const n of names) {
  const kp = loadKeypair(`.keys/${n}.json`);
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
}
const deployer = loadKeypair(".keys/deployer.json");
const buyer = loadKeypair(".keys/buyer.json");
const mint = await createMint(conn, deployer, deployer.publicKey, null, 6);
const ata = await getOrCreateAssociatedTokenAccount(conn, deployer, mint, buyer.publicKey);
await mintTo(conn, deployer, mint, ata.address, deployer, 100_000_000);
console.log(mint.toBase58());
