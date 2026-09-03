/**
 * test-planning.js — Build 2, planning and replanning.
 *
 * Run with:  node test-planning.js
 *
 * The marks here are not for producing a plan — any model will produce a plan
 * if you ask. They are for:
 *
 *   - deciding WHICH requests deserve one (and defending the threshold)
 *   - revising the plan when reality disagrees, rather than marching on
 *   - persisting both, so revisions are inspectable afterwards
 */

require("dotenv").config();
const { connectDB, disconnectDB } = require("./src/db/connection");
const { connectVectorStore } = require("./src/rag/vectorStore");
const { runAgent } = require("./src/agent/agentRunner");
const { classifyRequest, shouldReplan } = require("./src/agent/planner");
const { getToolDefinitions } = require("./src/tools/toolRegistry");
const { AgentRun } = require("./src/db/models");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

async function main() {
  await connectDB();
  await connectVectorStore();

  let allPass = true;
  const track = (p) => { if (!p) allPass = false; };

  // =====================================================================
  line("A.  THE THRESHOLD — which requests deserve a plan?");

  console.log(`
  A plan costs an extra LLM call before any work starts. Planning
  everything makes trivial questions slower and dearer; planning nothing
  lets complex requests improvise.

  Our threshold: plan when the request needs MORE THAN ONE ACT.
`);

  const cases = [
    ["where is my order", false],
    ["what is your refund policy", false],
    ["was I charged twice", false],
    ["I am alice@shop.com, show me my orders", false],
    ["My invoice charged me twice - refund the duplicate and tell me why it happened", true],
    ["Check if ord_1001 is refundable, and if it is, refund it", true],
    ["Look up my orders and then refund the Pro Plan one", true],
  ];

  let right = 0;
  let llmCalls = 0;

  for (const [msg, expected] of cases) {
    const v = await classifyRequest(msg);
    const ok = v.needsPlan === expected;
    if (ok) right++;
    if (v.decidedBy === "llm") llmCalls++;
    console.log(
      `  ${ok ? "ok  " : "MISS"}  plan=${String(v.needsPlan).padEnd(5)} ` +
      `by ${v.decidedBy.padEnd(4)}  "${msg.slice(0, 52)}"`
    );
  }

  console.log(`\n  correct           : ${right}/${cases.length}`);
  console.log(`  needed an LLM call: ${llmCalls}/${cases.length}`);
  const aPass = right >= cases.length - 1;
  track(aPass);
  console.log(
    `\n  ${aPass
      ? "PASS — and most decisions cost nothing, which is the point:\n" +
        "         a classifier that spends an LLM call to decide whether to\n" +
        "         spend an LLM call has spent it either way."
      : "FAIL — the classifier is not reliable enough to trust."}`
  );

  // =====================================================================
  line("B.  REPLAN TRIGGERS — 'unexpected' is not the same as 'failed'");

  console.log(`
  A tool can SUCCEED and still invalidate the plan:

      checkRefundEligibility -> ok, eligible: FALSE

  That call worked perfectly. Every remaining step is now wrong. A trigger
  that only watches for errors marches straight past it.
`);

  const triggers = [
    ["hard tool error", [{ name: "getCustomer", ok: false, result: { error: "customer_not_found" } }], true],
    ["successful but not eligible", [{ name: "checkRefundEligibility", ok: true, result: { eligible: false, policyRule: "refund_window" } }], true],
    ["knowledge base found nothing", [{ name: "searchKnowledgeBase", ok: true, result: { found: 0 } }], true],
    ["everything fine", [{ name: "getOrders", ok: true, result: { orders: [1, 2] } }], false],
    ["retryable arg error", [{ name: "getOrders", ok: false, result: { error: "invalid_arguments" } }], false],
  ];

  let tRight = 0;
  for (const [label, calls, expected] of triggers) {
    const v = shouldReplan(calls);
    const ok = v.replan === expected;
    if (ok) tRight++;
    console.log(`  ${ok ? "ok  " : "MISS"}  replan=${String(v.replan).padEnd(5)} ${label}`);
  }
  track(tRight === triggers.length);
  console.log(
    `\n  ${tRight === triggers.length
      ? "PASS — a successful-but-contradicting result triggers a replan;\n         a retryable argument error does not."
      : "FAIL"}`
  );

  // =====================================================================
  line("C.  A SIMPLE REQUEST GETS NO PLAN");

  const events1 = [];
  const simple = await runAgent("I'm alice@shop.com, what orders do I have?", {
    callerId: "cus_001",
    onEvent: (e) => events1.push(e),
  });

  const classified1 = events1.find((e) => e.type === "classified");
  const planned1 = events1.find((e) => e.type === "plan");

  console.log(`\n  classified needsPlan : ${classified1?.needsPlan}`);
  console.log(`  reason               : ${classified1?.reason}`);
  console.log(`  decided by           : ${classified1?.decidedBy}`);
  console.log(`  plan produced        : ${!!planned1}`);
  console.log(`  answered             : ${simple.reply.slice(0, 70)}`);

  const cPass = classified1?.needsPlan === false && !planned1;
  track(cPass);
  console.log(
    `\n  ${cPass
      ? "PASS — no plan, no extra latency, still answered correctly."
      : "FAIL — planned a request that did not need one."}`
  );

  // =====================================================================
  line("D.  A MULTI-STEP REQUEST GETS A PLAN, SHOWN BEFORE EXECUTION");

  const events2 = [];
  const complex = await runAgent(
    "My last invoice charged me twice - please refund the duplicate and tell me why it happened. I'm alice@shop.com.",
    { callerId: "cus_001", onEvent: (e) => events2.push(e) }
  );

  const planEvent = events2.find((e) => e.type === "plan");
  const firstToolIdx = events2.findIndex((e) => e.type === "tool_call");
  const planIdx = events2.findIndex((e) => e.type === "plan");

  if (planEvent) {
    console.log(`\n  Plan (${planEvent.plan.length} steps):\n`);
    planEvent.plan.forEach((s) =>
      console.log(`    ${s.step}. ${s.action}\n       tool: ${s.tool ?? "—"}  expects: ${s.expected}`)
    );
  } else {
    console.log("\n  (no plan produced)");
  }

  console.log(`\n  plan emitted at event #${planIdx}, first tool call at #${firstToolIdx}`);
  const dPass = !!planEvent && planIdx >= 0 && (firstToolIdx === -1 || planIdx < firstToolIdx);
  track(dPass);
  console.log(
    `\n  ${dPass
      ? "PASS — the plan was produced and shown BEFORE any execution began."
      : "FAIL — no plan, or execution started first."}`
  );

  // =====================================================================
  line("E.  REPLANNING — the plan changes when reality disagrees");

  console.log(`
  ord_1002 was delivered 115 days ago, outside the 30-day window. A plan
  that assumes a refund is possible must be revised when eligibility
  comes back false — not blindly executed.
`);

  const events3 = [];
  const replanned = await runAgent(
    "I'm alice@shop.com. Please refund my Onboarding Support Package order and confirm when it is done.",
    { callerId: "cus_001", onEvent: (e) => events3.push(e) }
  );

  const replanEvents = events3.filter((e) => e.type === "replanning");
  const planEvents = events3.filter((e) => e.type === "plan");

  console.log(`  plans emitted    : ${planEvents.length}`);
  console.log(`  replans triggered: ${replanEvents.length}`);
  replanEvents.forEach((e) => console.log(`    revision ${e.revision}: ${e.reason}`));

  console.log(`\n  tools called:`);
  for (const t of replanned.trace)
    for (const c of t.toolCalls)
      console.log(`    ${c.name} -> ${c.ok ? "ok" : c.result.error}`);

  console.log(`\n  final answer: ${replanned.reply.slice(0, 180)}`);
  console.log(`\n  plan revisions recorded on the run: ${replanned.planRevisions}`);

  const refundIssued = replanned.trace.some((t) =>
    t.toolCalls.some((c) => c.name === "issueRefund" && c.ok)
  );
  const ePass = !refundIssued;
  track(ePass);
  console.log(
    `\n  ${ePass
      ? "PASS — no refund was issued on an ineligible order."
      : "FAIL — the plan was executed blindly."}`
  );

  // =====================================================================
  line("F.  THE PLAN AND ITS REVISIONS ARE PERSISTED");

  await new Promise((r) => setTimeout(r, 900));
  const stored = await AgentRun.findOne({ runId: complex.runId }).lean();

  console.log(`\n  run found in MongoDB : ${!!stored}`);
  console.log(`  plan stored          : ${!!stored?.plan}`);
  console.log(`  steps                : ${stored?.plan?.steps?.length ?? 0}`);
  console.log(`  revisions            : ${stored?.planRevisions ?? 0}`);
  if (stored?.plan?.steps) {
    console.log(`\n  step statuses: ${stored.plan.steps.map((s) => `${s.step}=${s.status}`).join(", ")}`);
  }

  const fPass = !!stored?.plan;
  track(fPass);
  console.log(
    `\n  ${fPass
      ? "PASS — the plan survives the request, so revisions are inspectable later."
      : "FAIL — the plan was not persisted."}`
  );

  // =====================================================================
  line(allPass ? "ALL PLANNING TESTS PASSED" : "SOME TESTS FAILED");
  console.log(`
  The defensible bit is not that we plan — it is that we mostly DON'T,
  and can say why. Most requests are classified for free by code; only
  genuinely ambiguous ones cost a classifier call; and only multi-act
  requests pay for a plan.
`);

  await disconnectDB();
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  await disconnectDB();
  process.exit(1);
});
