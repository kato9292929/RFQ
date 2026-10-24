// Rent for the program and every account it creates, measured with
// getMinimumBalanceForRentExemption on the given RPC (default: public mainnet).
//   npx tsx scripts/rent-check.ts [--json] [--balance <pubkey>] [--margin-sol 0.3]
// With --balance, exits 3 when that account holds less than (deploy rent + margin).
// Used by scripts/deploy-mainnet.sh before it deploys, and for docs/cost.md.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { ROOT } from "../lib/common.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const rpc = process.env.RENT_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const marginSol = Number(flag("--margin-sol") ?? "0.3");

const so = resolve(ROOT, "target/deploy/rfq_market.so");
const programBytes = statSync(so).size;

// 8-byte Anchor discriminator + INIT_SPACE of each struct in programs/rfq_market/src/lib.rs.
const ACCOUNTS: { name: string; bytes: number; payer: string; when: string }[] = [
  { name: "ProgramData (header 45 + .so)", bytes: 45 + programBytes, payer: "deployer", when: "deploy (once)" },
  { name: "Program", bytes: 36, payer: "deployer", when: "deploy (once)" },
  { name: "Config", bytes: 8 + 32 + 32 + 2 + 32 + 1, payer: "deployer", when: "initialize (once)" },
  { name: "Treasury USDC ATA", bytes: 165, payer: "deployer", when: "initialize (once, if missing)" },
  { name: "Rfq", bytes: 8 + 32 + 8 + 32 + (4 + 200) + 8 + 8 + 1 + (1 + 32) + 8 + 1, payer: "buyer", when: "post_rfq" },
  { name: "Quote", bytes: 8 + 32 + 32 + 8 + 32 + (4 + 200) + 8 + 8 + 1, payer: "seller / buyer (catalog)", when: "submit_quote / submit_catalog_quote" },
  { name: "CatalogQuote", bytes: 8 + 32 * 3 + (4 + 100) + (4 + 64) + (4 + 64) + 8 + 1, payer: "buyer", when: "submit_catalog_quote" },
  { name: "Fulfillment", bytes: 8 + 32 + 32 + 64 + 32 + 8 + 1, payer: "buyer", when: "record_fulfillment" },
  { name: "Rejection", bytes: 8 + 32 * 3 + 64 + 32 + 1 + 8 + 1, payer: "buyer", when: "record_rejection" },
  { name: "Sla", bytes: 8 + 32 + 32 + 4 + 4 + 1 + 8 + 1, payer: "seller", when: "declare_sla (optional)" },
];

const conn = new Connection(rpc, "confirmed");
// The public mainnet RPC rate-limits bursts; space the calls out.
const pause = () => new Promise((r) => setTimeout(r, Number(process.env.RENT_RPC_PAUSE_MS ?? "1500")));
const genesis = await conn.getGenesisHash();
const rows: ((typeof ACCOUNTS)[number] & { lamports: number })[] = [];
for (const a of ACCOUNTS) {
  await pause();
  rows.push({ ...a, lamports: await conn.getMinimumBalanceForRentExemption(a.bytes) });
}
const by = (n: string) => rows.find((r) => r.name.split(" ")[0] === n)!.lamports;
// Rent-exempt minimum = (128-byte account overhead + data bytes) × rate.
const rate = rows[0].lamports / (128 + rows[0].bytes);
const deployRent = by("ProgramData") + by("Program") + by("Config") + by("Treasury");
const perRfq = {
  seller_fulfilled: by("Rfq") + by("Quote") + by("Fulfillment"),
  catalog_fulfilled: by("Rfq") + by("Quote") + by("CatalogQuote") + by("Fulfillment"),
  catalog_rejected: by("Rfq") + by("Quote") + by("CatalogQuote") + by("Rejection"),
};
const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(9);
const out = {
  measured_at: new Date().toISOString(), rpc: rpc.replace(/api-key=[^&]+/, "api-key=***"), genesis,
  lamports_per_byte: Math.round(rate), program_so_bytes: programBytes,
  accounts: rows, deploy_rent_lamports: deployRent, per_rfq_lamports: perRfq,
};

if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`rent measured ${out.measured_at} on ${out.rpc} (genesis ${genesis})`);
  console.log(`rate ≈ ${out.lamports_per_byte} lamports/byte (incl. 128-byte overhead)`);
  for (const r of rows) console.log(`  ${r.name.padEnd(30)} ${String(r.bytes).padStart(7)} B  ${sol(r.lamports)} SOL  (${r.payer}, ${r.when})`);
  console.log(`  deploy total (program + config + treasury): ${sol(deployRent)} SOL`);
  for (const [k, v] of Object.entries(perRfq)) console.log(`  per RFQ ${k.padEnd(18)} ${sol(v)} SOL`);
}

const who = flag("--balance");
if (who) {
  await pause();
  const bal = await conn.getBalance(new PublicKey(who), "confirmed");
  const need = deployRent + Math.round(marginSol * LAMPORTS_PER_SOL);
  console.log(`deployer ${who}: balance ${sol(bal)} SOL, needs ≥ ${sol(need)} SOL (deploy rent + ${marginSol} SOL)`);
  if (bal < need) { console.log(`STOP: short by ${sol(need - bal)} SOL`); process.exit(3); }
  console.log("balance OK");
}
