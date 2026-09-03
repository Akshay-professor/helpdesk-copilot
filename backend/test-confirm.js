/**
 * test-confirm.js — Step 6 verification.
 *
 * Run with:  node test-confirm.js
 *
 * Proves the confirmation pause works, and — most importantly — that a paused
 * run is resumable from DATA ALONE. The restart test at the end is the one
 * that matters: it is what makes this the version Build 2 can extend rather
 * than replace.
 */

require("dotenv").config();
const { runAgent, resumeAgent } = require("./src/agent/agentRunner");
const repo = require("./src/data/repository");
const { connectDB, disconnectDB } = require("./src/db/connection");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));
const traceOf = (r) =>
  r.trace.forEach((t) =>
    t.toolCalls.forEach((c) =>
      console.log(`    [${t.iteration}] ${c.name} -> ${c.ok ? "ok" : "blocked: " + c.result.error}`)
    )
  );

const refunded = async (id) => (await repo.findOrderById(id)).refundedAmount;

async function main() {
  await connectDB();
  // =====================================================================
  line("A.  PAUSE — the agent must stop before writing");

  const before = await refunded("ord_1001");
  console.log(`\n  ord_1001 refunded before: $${before}`);

  const paused = await runAgent(
    "I'm alice@shop.com. Please refund $50 on order ord_1001 for the duplicate charge."
  );

  console.log(`\n  status: ${paused.status}`);
  traceOf(paused);

  if (paused.status !== "awaiting_confirmation") {
    console.log("\n  FAIL — expected a pause.");
    return;
  }

  console.log("\n  Confirmation shown to the user:");
  const s = paused.pending.summary;
  console.log(`    action       : ${s.action}`);
  console.log(`    detail       : ${s.detail}`);
  console.log(`    reason       : ${s.reason}`);
  console.log(`    irreversible : ${s.irreversible}`);
  console.log(`    warning      : ${s.warning}`);

  console.log(`\n  ord_1001 refunded during pause: $${await refunded("ord_1001")}`);
  console.log(
    `  ${await refunded("ord_1001") === before
      ? "PASS — nothing executed while waiting."
      : "FAIL — money moved before confirmation!"}`
  );

  // =====================================================================
  line("B.  REJECT — a refusal must not crash the run");

  const rejected = await resumeAgent(paused, false, {
    rejectionNote: "Customer changed their mind and wants store credit instead.",
  });

  console.log(`\n  status: ${rejected.status}`);
  traceOf(rejected);
  console.log(`\n  Agent: ${rejected.reply.slice(0, 260)}`);
  console.log(`\n  ord_1001 refunded after rejection: $${await refunded("ord_1001")}`);
  console.log(
    `  ${await refunded("ord_1001") === before
      ? "PASS — rejection honoured, no money moved."
      : "FAIL — refund happened anyway!"}`
  );

  // =====================================================================
  line("C.  APPROVE — confirming must actually execute it");

  const paused2 = await runAgent(
    "I'm alice@shop.com. Please refund $50 on order ord_1001 for the duplicate charge."
  );

  if (paused2.status !== "awaiting_confirmation") {
    console.log("\n  FAIL — expected a pause.");
    return;
  }

  const approved = await resumeAgent(paused2, true);
  console.log(`\n  status: ${approved.status}`);
  traceOf(approved);
  console.log(`\n  Agent: ${approved.reply.slice(0, 260)}`);
  console.log(`\n  ord_1001 refunded after approval: $${await refunded("ord_1001")}`);
  console.log(
    `  ${await refunded("ord_1001") > before
      ? "PASS — refund executed only after approval."
      : "FAIL — approval did nothing!"}`
  );

  // =====================================================================
  line("D.  MODIFY — human edits the amount (Build 2 requirement, free here)");

  const paused3 = await runAgent(
    "I'm bob@shop.com. Please apply $40 account credit for the delay on my order."
  );

  if (paused3.status === "awaiting_confirmation") {
    console.log(`\n  Agent proposed: ${paused3.pending.summary.detail}`);
    const bobBefore = (await repo.findCustomerById("cus_002")).accountCredit;

    const modified = await resumeAgent(paused3, true, {
      modifiedArguments: { ...paused3.pending.arguments, amount: 15 },
    });

    const bobAfter = (await repo.findCustomerById("cus_002")).accountCredit;
    console.log(`  Human changed it to $15.`);
    console.log(`  Bob's credit: $${bobBefore} -> $${bobAfter}`);
    console.log(
      `  ${bobAfter - bobBefore === 15
        ? "PASS — the edited value was applied, not the original."
        : "FAIL — wrong amount applied."}`
    );
  } else {
    // Not a guard failure - the agent sometimes answers without proposing a
    // credit at all. Print why, so this is distinguishable from a real break.
    console.log(`\n  (agent did not propose a credit; status=${paused3.status})`);
    console.log(`  reply: ${paused3.reply.slice(0, 180)}`);
    console.log(`  SKIPPED — nothing to modify. Re-run to retry.`);
  }

  // =====================================================================
  line("E.  MODIFY CANNOT BYPASS POLICY");

  const paused4 = await runAgent(
    "I'm carol@shop.com. Please refund $50 on order ord_3001."
  );

  if (paused4.status === "awaiting_confirmation") {
    console.log("\n  Agent proposed a $50 refund.");
    console.log("  Human edits it to $5000 — above the $2000 hard ceiling...");

    const c3before = await refunded("ord_3001");
    const sneaky = await resumeAgent(paused4, true, {
      modifiedArguments: { ...paused4.pending.arguments, amount: 5000 },
    });

    traceOf(sneaky);
    console.log(`\n  ord_3001 refunded: $${c3before} -> $${await refunded("ord_3001")}`);
    console.log(
      `  ${await refunded("ord_3001") === c3before
        ? "PASS — approval changes WHO asked, never WHAT is allowed."
        : "FAIL — policy bypassed via modify!"}`
    );
  } else {
    console.log(`\n  (no pause; status=${paused4.status})`);
  }

  // =====================================================================
  line("F.  THE RESTART TEST — resumable from data alone");

  const paused5 = await runAgent(
    "I'm alice@shop.com. Please refund $20 on order ord_1001."
  );

  if (paused5.status !== "awaiting_confirmation") {
    console.log(`\n  (no pause; status=${paused5.status})`);
    return;
  }

  // Round-trip through JSON. This is what a server restart does to state: if
  // anything only existed in memory - a closure, a pending promise, a class
  // instance - it does not survive this and resuming would fail.
  const serialized = JSON.stringify(paused5);
  console.log(`\n  Paused state serialised: ${serialized.length} bytes of JSON`);
  console.log("  (simulating: written to DB, server restarted, read back)");

  const revived = JSON.parse(serialized);
  const resumedAfterRestart = await resumeAgent(revived, true);

  console.log(`\n  status: ${resumedAfterRestart.status}`);
  traceOf(resumedAfterRestart);
  console.log(`\n  Agent: ${resumedAfterRestart.reply.slice(0, 200)}`);
  console.log(
    `\n  ${resumedAfterRestart.status === "complete"
      ? "PASS — resumed correctly from serialised state alone.\n" +
        "         This is what Build 2 needs to survive a real restart."
      : "FAIL — could not resume from serialised state."}`
  );

  // =====================================================================
  line("SUMMARY");
  console.log(`  ord_1001 total refunded : $${await refunded("ord_1001")}`);
  console.log(`  ord_3001 total refunded : $${await refunded("ord_3001")}  (must be $0)`);
  console.log("");
}

main().then(()=>disconnectDB()).catch(async (err) => {
  await disconnectDB();
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
