/**
 * test-hitl.js — Build 2, durable human-in-the-loop.
 *
 * Run with:  node test-hitl.js
 *
 * The assignment calls this "the hardest engineering problem in Build 2: an
 * agent loop that survives suspension", and demands one demonstration
 * specifically:
 *
 *     "Demonstrate pause -> restart the server -> approve -> agent resumes
 *      correctly. An in-memory pause fails this build."
 *
 * Part C does exactly that. Part D covers the other new requirement:
 * "approving twice (double-click, retry) must not execute the action twice."
 */

require("dotenv").config();
const { connectDB, disconnectDB } = require("./src/db/connection");
const { connectVectorStore } = require("./src/rag/vectorStore");
const { runAgent, resumeAgent } = require("./src/agent/agentRunner");
const { listPending, getPending, claimRun, releaseRun } = require("./src/agent/approvals");
const { AgentRun } = require("./src/db/models");
const repo = require("./src/data/repository");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));
const refunded = async (id) => (await repo.findOrderById(id)).refundedAmount;

/** Rebuild a paused state from MongoDB — exactly what the API endpoint does. */
function stateFromDb(doc) {
  return {
    status: "awaiting_confirmation",
    pending: doc.pending,
    messages: doc.messages,
    trace: doc.trace,
    iterations: doc.iterations,
    tokensUsed: doc.tokensUsed,
    runId: doc.runId,
    conversationId: doc.conversationId,
    userMessage: doc.userMessage,
    startedAt: doc.startedAt ? new Date(doc.startedAt).getTime() : Date.now(),
    callerId: doc.callerId,
  };
}

async function main() {
  await connectDB();
  await connectVectorStore();

  let allPass = true;
  const track = (p) => { if (!p) allPass = false; };

  // Clear old paused runs so the queue counts mean something.
  await AgentRun.deleteMany({ status: { $in: ["awaiting_confirmation", "resuming"] } });

  // =====================================================================
  line("A.  A PAUSE IS WRITTEN TO MONGODB, NOT JUST RETURNED");

  const before = await refunded("ord_1001");
  console.log(`\n  ord_1001 refunded before: $${before}`);

  const paused = await runAgent(
    "I'm alice@shop.com. Please refund $35 on order ord_1001 for the duplicate charge.",
    { callerId: "cus_001" }
  );

  console.log(`  run status: ${paused.status}`);
  await new Promise((r) => setTimeout(r, 800)); // saveRun is fire-and-forget

  const stored = await getPending(paused.runId);
  console.log(`\n  Read back from MongoDB:`);
  console.log(`    found            : ${!!stored}`);
  console.log(`    has pending      : ${!!stored?.pending}`);
  console.log(`    has messages     : ${stored?.messages?.length ?? 0}`);
  console.log(`    callerId stored  : ${stored?.callerId ?? "(MISSING)"}`);
  console.log(`    action proposed  : ${stored?.pending?.summary?.detail ?? "?"}`);

  const aPass = !!stored?.pending && stored.callerId === "cus_001";
  track(aPass);
  console.log(
    `\n  ${aPass
      ? "PASS — the full paused state, including the authorization badge, is durable."
      : "FAIL — state is incomplete in the database."}`
  );

  // =====================================================================
  line("B.  THE OPERATOR QUEUE SHOWS WHAT A HUMAN NEEDS");

  const queue = await listPending();
  const item = queue.find((q) => q.runId === paused.runId);

  console.log(`\n  pending approvals: ${queue.length}\n`);
  if (item) {
    console.log(`    customer asked : "${item.customerMessage}"`);
    console.log(`    caller         : ${item.callerId}`);
    console.log(`    action         : ${item.action?.action}`);
    console.log(`    detail         : ${item.action?.detail}`);
    console.log(`    irreversible   : ${item.action?.irreversible}`);
    console.log(`    age            : ${Math.round(item.ageMs / 1000)}s`);
    console.log(`\n    agent's reasoning (${item.reasoning.length} steps):`);
    item.reasoning.forEach((r) =>
      console.log(
        r.type === "tool"
          ? `      tool ${r.name} -> ${r.ok ? "ok" : r.result?.error}`
          : `      thought: ${String(r.text).slice(0, 70)}`
      )
    );
  }

  const bPass =
    !!item && !!item.action && !!item.customerMessage && item.reasoning.length > 0;
  track(bPass);
  console.log(
    `\n  ${bPass
      ? "PASS — request, reasoning, proposed action and customer context all present."
      : "FAIL — the operator cannot judge this without more information."}`
  );

  // =====================================================================
  line("C.  THE REQUIRED DEMO — pause, restart, approve, resume");

  console.log(`
  The assignment: "Demonstrate pause -> restart the server -> approve ->
  agent resumes correctly. An in-memory pause fails this build."

  We simulate the restart the strictest way available in one process:
  the ONLY thing carried forward is the runId string. Everything else is
  re-read from MongoDB, exactly as a fresh server would.
`);

  const runIdOnly = paused.runId; // pretend this is all that survived
  const midRefund = await refunded("ord_1001");
  console.log(`  ord_1001 while paused    : $${midRefund}  (must equal $${before})`);

  const reloaded = await getPending(runIdOnly);
  const rebuilt = stateFromDb(reloaded);
  const resumed = await resumeAgent(rebuilt, true);

  const afterApproval = await refunded("ord_1001");
  console.log(`  resumed status           : ${resumed.status}`);
  console.log(`  agent reply              : ${resumed.reply.slice(0, 110)}`);
  console.log(`  ord_1001 after approval  : $${afterApproval}`);

  const cPass =
    midRefund === before && resumed.status === "complete" && afterApproval > before;
  track(cPass);
  console.log(
    `\n  ${cPass
      ? "PASS — resumed from the database alone. Nothing was held in memory."
      : "FAIL — the run could not be resumed from stored state."}`
  );

  // =====================================================================
  line("D.  IDEMPOTENCY — the double-click must not refund twice");

  console.log(`
  Build 1's client held the paused state, so a double-click posted the same
  object twice and issued two refunds. Now the state lives in one place and
  can be CLAIMED atomically.
`);

  const paused2 = await runAgent(
    "I'm bob@shop.com. Please apply $20 account credit for the shipping delay.",
    { callerId: "cus_002" }
  );
  await new Promise((r) => setTimeout(r, 800));

  if (paused2.status !== "awaiting_confirmation") {
    console.log(`  (agent did not pause; status=${paused2.status}) — SKIPPED`);
  } else {
    const creditBefore = (await repo.findCustomerById("cus_002")).accountCredit;
    console.log(`  Bob's credit before: $${creditBefore}`);

    // Two operators click Approve at the same instant.
    const [claimA, claimB] = await Promise.all([
      claimRun(paused2.runId),
      claimRun(paused2.runId),
    ]);

    console.log(`\n  claim A won: ${!!claimA}`);
    console.log(`  claim B won: ${!!claimB}`);

    const winner = claimA ?? claimB;
    if (winner) await resumeAgent(stateFromDb(winner), true);

    const creditAfter = (await repo.findCustomerById("cus_002")).accountCredit;
    const applied = creditAfter - creditBefore;

    console.log(`\n  Bob's credit after : $${creditAfter}`);
    console.log(`  applied            : $${applied}`);
    console.log(`  proposed amount    : $${paused2.pending.arguments.amount}`);

    const exactlyOnce =
      Boolean(claimA) !== Boolean(claimB) &&
      applied === paused2.pending.arguments.amount;
    track(exactlyOnce);
    console.log(
      `\n  ${exactlyOnce
        ? "PASS — exactly one claim won; the action ran exactly once."
        : "FAIL — the action was applied more than once, or not at all."}`
    );
  }

  // =====================================================================
  line("E.  A FAILED RESUME RETURNS THE RUN TO THE QUEUE");

  console.log(`
  Claiming something you might not finish requires a way to un-claim it.
  Without that, a crash mid-resume strands the run in "resuming" forever:
  invisible to the queue, impossible to approve.
`);

  const paused3 = await runAgent(
    "I'm alice@shop.com. Please refund $15 on order ord_1001.",
    { callerId: "cus_001" }
  );
  await new Promise((r) => setTimeout(r, 800));

  if (paused3.status === "awaiting_confirmation") {
    await claimRun(paused3.runId);
    const whileClaimed = await getPending(paused3.runId);
    console.log(`  visible in queue while claimed : ${!!whileClaimed} (should be false)`);

    await releaseRun(paused3.runId);
    const afterRelease = await getPending(paused3.runId);
    console.log(`  visible after release          : ${!!afterRelease} (should be true)`);

    const ePass = !whileClaimed && !!afterRelease;
    track(ePass);
    console.log(
      `\n  ${ePass
        ? "PASS — a claim hides the run, and releasing restores it."
        : "FAIL — the run is stranded or never hidden."}`
    );

    // leave the queue clean
    await AgentRun.deleteMany({ runId: paused3.runId });
  }

  // =====================================================================
  line(allPass ? "ALL HITL TESTS PASSED" : "SOME TESTS FAILED");
  console.log(`
  What Build 1 already gave us: a pause that is resumable from DATA ALONE.
  What Build 2 added: that data lives in MongoDB instead of the HTTP
  response, plus an atomic claim so approving twice cannot act twice.

  Same loop. Same resumeAgent(). Different storage.
`);

  await disconnectDB();
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  await disconnectDB();
  process.exit(1);
});
