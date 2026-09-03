/**
 * test-db.js — Step 7 verification.
 *
 * Run with:  node test-db.js
 *
 * Proves three things the assignment requires:
 *   1. Business data comes from MongoDB, not memory
 *   2. Every agent run is persisted with its full trace
 *   3. A correlation ID ties a refund back to the conversation that caused it
 *
 * And one thing that matters more than any of them: THE DATA SURVIVES A
 * RESTART. Everything before this step was forgotten the moment the process
 * ended.
 */

require("dotenv").config();
const { connectDB, disconnectDB, isConnected } = require("./src/db/connection");
const { runAgent, resumeAgent } = require("./src/agent/agentRunner");
const { loadRun, listRuns } = require("./src/db/persistence");
const { Order, Refund, AgentRun, ToolCall } = require("./src/db/models");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

async function main() {
  const ok = await connectDB();
  console.log(`\nMongoDB: ${ok ? "connected" : "NOT connected"}`);
  if (!ok) {
    console.error("Start it with:  docker start helpdesk-mongo");
    process.exit(1);
  }

  // =====================================================================
  line("A.  DATA COMES FROM THE DATABASE");

  const before = await Order.findOne({ id: "ord_1001" }).lean();
  console.log(`\n  ord_1001 from MongoDB: $${before.total}, refunded $${before.refundedAmount}`);
  console.log(`  (this row was loaded from disk, not from a JS array)`);

  // =====================================================================
  line("B.  A RUN IS PERSISTED WITH ITS FULL TRACE");

  const r = await runAgent("I'm alice@shop.com - what orders do I have?");
  console.log(`\n  runId      : ${r.runId}`);
  console.log(`  status     : ${r.status}`);
  console.log(`  iterations : ${r.iterations}`);

  // saveRun is fire-and-forget, so give it a moment to land.
  await new Promise((res) => setTimeout(res, 700));

  const stored = await loadRun(r.runId);
  console.log(`\n  Read back from MongoDB:`);
  console.log(`    found        : ${stored ? "yes" : "NO"}`);
  if (stored) {
    console.log(`    status       : ${stored.status}`);
    console.log(`    iterations   : ${stored.iterations}`);
    console.log(`    tokensUsed   : ${stored.tokensUsed}`);
    console.log(`    trace entries: ${stored.trace.length}`);
    console.log(`    messages     : ${stored.messages.length}`);
    console.log(`    durationMs   : ${stored.durationMs}`);
  }

  const calls = await ToolCall.find({ runId: r.runId }).lean();
  console.log(`\n  Tool call records: ${calls.length}`);
  calls.forEach((c) =>
    console.log(`    ${c.name}  ok=${c.ok}  ${c.durationMs}ms  args=${JSON.stringify(c.arguments)}`)
  );
  console.log(
    `\n  ${stored && stored.trace.length > 0 ? "PASS — run and trace persisted." : "FAIL"}`
  );

  // =====================================================================
  line("C.  CORRELATION ID — a refund traces back to its conversation");

  const paused = await runAgent(
    "I'm alice@shop.com. Refund $25 on order ord_1001 for the duplicate charge."
  );

  if (paused.status !== "awaiting_confirmation") {
    console.log(`\n  (expected a pause, got ${paused.status})`);
  } else {
    console.log(`\n  Paused. runId: ${paused.runId}`);
    console.log(`  Proposed: ${paused.pending.summary.detail}`);

    const done = await resumeAgent(paused, true);
    await new Promise((res) => setTimeout(res, 700));

    console.log(`\n  Approved. Same runId? ${done.runId === paused.runId ? "yes" : "NO"}`);

    const refund = await Refund.findOne({ runId: done.runId }).lean();
    if (refund) {
      console.log(`\n  Refund record in MongoDB:`);
      console.log(`    id     : ${refund.id}`);
      console.log(`    amount : $${refund.amount}`);
      console.log(`    reason : ${refund.reason}`);
      console.log(`    runId  : ${refund.runId}`);

      // The point of the correlation ID: go from a refund to the whole story.
      const conversation = await loadRun(refund.runId);
      console.log(`\n  ...and that runId pulls up the conversation that caused it:`);
      console.log(`    user asked   : "${conversation.userMessage}"`);
      console.log(`    agent replied: "${conversation.reply.slice(0, 90)}..."`);
      console.log(`    tools used   : ${conversation.trace.flatMap(t => t.toolCalls.map(c => c.name)).join(" -> ")}`);
      console.log(`\n  PASS — a refund is traceable to its conversation.`);
    } else {
      console.log(`\n  FAIL — no refund record found for this run.`);
    }

    const after = await Order.findOne({ id: "ord_1001" }).lean();
    console.log(`\n  ord_1001 refundedAmount: $${before.refundedAmount} -> $${after.refundedAmount}`);
  }

  // =====================================================================
  line("D.  WHAT IS NOW IN THE DATABASE");

  console.log(`\n  agent runs  : ${await AgentRun.countDocuments()}`);
  console.log(`  tool calls  : ${await ToolCall.countDocuments()}`);
  console.log(`  refunds     : ${await Refund.countDocuments()}`);

  const recent = await listRuns(5);
  console.log(`\n  Most recent runs:`);
  recent.forEach((x) =>
    console.log(`    ${x.runId.slice(0, 8)}  ${x.status.padEnd(22)} ${x.iterations} iters, ${x.tokensUsed} tokens`)
  );

  // =====================================================================
  line("E.  CROSS-RUN ANALYTICS — why tool calls are stored separately");

  const stats = await ToolCall.aggregate([
    {
      $group: {
        _id: "$name",
        calls: { $sum: 1 },
        failures: { $sum: { $cond: ["$ok", 0, 1] } },
        avgMs: { $avg: "$durationMs" },
      },
    },
    { $sort: { calls: -1 } },
  ]);

  console.log("\n  tool                      calls  failures  avg ms");
  console.log("  " + "-".repeat(52));
  stats.forEach((s) =>
    console.log(
      `  ${s._id.padEnd(26)}${String(s.calls).padEnd(7)}${String(s.failures).padEnd(10)}${Math.round(s.avgMs)}`
    )
  );
  console.log(
    "\n  This query is impossible against the embedded trace alone —\n" +
    "  which is why ToolCall is its own collection."
  );

  await disconnectDB();
  console.log("\n" + "=".repeat(70));
  console.log("Now run this again. The counts go UP instead of resetting.");
  console.log("That is the whole point of Step 7.");
  console.log("=".repeat(70) + "\n");
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  await disconnectDB();
  process.exit(1);
});
