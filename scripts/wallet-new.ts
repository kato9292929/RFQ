// Create a mainnet wallet for this market: prints the secret key ONCE and never writes it
// to disk; only the public address goes into docs/wallet.md.
//   npm run wallet:new            → the first role still missing in docs/wallet.md (deployer, then buyer)
//   npm run wallet:new -- buyer   → a specific role (deployer | buyer)
//   npm run wallet:new -- buyer --secret-file <path>
//                                 → writes the secret line to <path> (0600) instead of printing it, so it
//                                   can be handed over as a file without entering a session transcript.
// Without --secret-file, run it in your own terminal, not inside a Claude/AI session.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";

const ROOT = resolve(import.meta.dirname, "..");
const WALLET_MD = resolve(ROOT, "docs/wallet.md");
const ROLES = { deployer: "MAINNET_DEPLOYER_KEYPAIR", buyer: "MAINNET_BUYER_KEYPAIR" } as const;
type Role = keyof typeof ROLES;

const secretFile = process.argv.includes("--secret-file") ? process.argv[process.argv.indexOf("--secret-file") + 1] : undefined;
if (process.env.CLAUDECODE && !secretFile) {
  console.error("refusing: this looks like a Claude Code session. Run `npm run wallet:new` in your own terminal.");
  process.exit(1);
}

const md = readFileSync(WALLET_MD, "utf8");
const marker = (r: Role) => new RegExp(`(<!-- wallet:${r} -->)[^|]*\\|`);
const unset = (r: Role) => (md.match(marker(r))?.[0] ?? "").includes("未作成");
const arg = (process.argv[2]?.startsWith("--") ? undefined : process.argv[2]) as Role | undefined;
const role: Role | undefined = arg ?? (Object.keys(ROLES) as Role[]).find(unset);
if (!role || !(role in ROLES)) {
  console.error(arg ? `unknown role "${arg}" (deployer | buyer)` : "deployer and buyer are both set in docs/wallet.md; pass a role to replace one");
  process.exit(1);
}
if (!unset(role) && !process.argv.includes("--replace")) {
  console.error(`${role} is already set in docs/wallet.md; add --replace to create a new one`);
  process.exit(1);
}

const kp = Keypair.generate();
const address = kp.publicKey.toBase58();
const date = new Date().toISOString().slice(0, 10);
writeFileSync(WALLET_MD, md.replace(marker(role), `$1 \`${address}\` (created ${date}) |`));

console.log(`role: ${role}`);
console.log(`public address: ${address}   (written to docs/wallet.md — commit it)`);
console.log("");
if (secretFile) {
  writeFileSync(secretFile, JSON.stringify(Array.from(kp.secretKey)) + "\n", { mode: 0o600 });
  console.log(`secret key for ${ROLES[role]} written to ${secretFile} (0600). Copy it into the secret, then delete the file.`);
} else {
  console.log(`secret key — register it as the secret ${ROLES[role]}, exactly this one line:`);
  console.log(JSON.stringify(Array.from(kp.secretKey)));
  console.log("");
  console.log("This is the only time it is shown. It is not saved anywhere; if you lose it, run wallet:new again.");
}
