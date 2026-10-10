// Append an operator-observed incident to the run log: npx tsx scripts/log-incident.ts '<json>'
import { appendLog, explorerTx } from "../lib/common.js";
const rec = JSON.parse(process.argv[2]);
appendLog({ actor: "operator", ...rec, ...(rec.payment_tx ? { explorer: explorerTx(rec.payment_tx) } : {}) });
