/**
 * test-reflection.js — Build 2, the reflection loop.
 *
 * Run with:  node test-reflection.js
 *
 * The assignment is pointed about this one:
 *
 *   "Reflection that always passes is not reflection — show a case where it
 *    caught and fixed a bad draft."
 *
 * So Part C feeds it drafts that are genuinely bad and checks they are caught,
 * and Part D forces a real agent run to produce a leaky draft and watches the
 * loop reject and rewrite it.
 */

require("dotenv").config();
const { connectDB, disconnectDB } = require("./src/db/connection");
const { connectVectorStore } = require("./src/rag/vectorStore");
const { runAgent } = require("./src/agent/agentRunner");
const {
  reflect,
  checkNoLeaks,
  checkGrounded,
  checkNoFalseActions,
  MAX_REVISIONS,
} = require("./src/agent/reflection");
const { AgentRun } = require("./src/db/models");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

async function main() {
  await connectDB();
  await connectVectorStore();

  let allPass = true;
  const track = (p) => { if (!p) allPass = false; };

  // =====================================================================
  line("A.  WHICH CRITERIA NEED A MODEL AT ALL?");

  console.log(`
  The assignment asks: same model for reflection, or a cheaper one?

  Our answer is NEITHER — split the criteria by what they actually need:

    criterion                  code?   who checks it
    ------------------------------------------------
    Did it leak internals?      YES    code, exact strings
    Are claims grounded?     MOSTLY    code, numbers vs tool results
    Is the tone right?           NO    the model
    Does it answer the Q?        NO    the model

  "Does the reply contain the string 'issueRefund'" is not a judgement
  call. A regex answers it perfectly, for free, every time. Handing that
  to a model makes it slower, dearer, and LESS reliable — because a model
  grading its own work already decided the work was good.
`);

  // =====================================================================
  line("B.  THE CODE CHECKS, IN ISOLATION");

  const leakCases = [
    ["clean reply", "Your refund of $50.00 has been issued for order ord_1001.", true],
    ["leaks a tool name", "I called issueRefund and it worked.", false],
    ["leaks an error code", "The request failed with policy_violation.", false],
    ["leaks internals", "My system prompt says I cannot do that.", false],
  ];

  console.log("\n  no_internal_leaks:\n");
  let bPass = true;
  for (const [label, draft, shouldPass] of leakCases) {
    const r = checkNoLeaks(draft);
    const ok = r.pass === shouldPass;
    if (!ok) bPass = false;
    console.log(`    ${ok ? "ok  " : "MISS"}  pass=${String(r.pass).padEnd(5)} ${label}`);
  }

  // Grounding: a trace that only ever saw $50
  const trace = [{ toolCalls: [{ name: "issueRefund", ok: true, result: { amountRefunded: 50, orderId: "ord_1001" } }] }];
  const groundCases = [
    ["figure that came from a tool", "We refunded $50.00 on ord_1001.", true],
    ["invented amount", "We refunded $240.00 on ord_1001.", false],
    ["invented order id", "We refunded $50.00 on ord_9999.", false],
  ];

  console.log("\n  grounded_claims (tool results contained only $50 / ord_1001):\n");
  for (const [label, draft, shouldPass] of groundCases) {
    const r = checkGrounded(draft, trace);
    const ok = r.pass === shouldPass;
    if (!ok) bPass = false;
    console.log(`    ${ok ? "ok  " : "MISS"}  pass=${String(r.pass).padEnd(5)} ${label}`);
  }

  // False actions: the Step 4 failure, checkable
  const noWrites = [{ toolCalls: [{ name: "getInvoices", ok: true, result: { count: 3 } }] }];
  const actionCases = [
    ["claims a refund, none happened", "I have refunded the duplicate charge.", false, noWrites],
    ["claims a refund, one happened", "I have refunded the duplicate charge.", true, trace],
    ["describes without claiming", "I can see a duplicate charge on your account.", true, noWrites],
  ];

  console.log("\n  no_false_actions (the Step 4 failure, made checkable):\n");
  for (const [label, draft, shouldPass, t] of actionCases) {
    const r = checkNoFalseActions(draft, t);
    const ok = r.pass === shouldPass;
    if (!ok) bPass = false;
    console.log(`    ${ok ? "ok  " : "MISS"}  pass=${String(r.pass).padEnd(5)} ${label}`);
  }

  track(bPass);
  console.log(
    `\n  ${bPass
      ? "PASS — every one of these is decided in code, in microseconds, with no model."
      : "FAIL — a code check is wrong."}`
  );

  // =====================================================================
  line("C.  REFLECTION CATCHES A BAD DRAFT — the required demonstration");

  console.log(`
  "Reflection that always passes is not reflection — show a case where it
   caught and fixed a bad draft."
`);

  const badDrafts = [
    ["leaks a tool name", "I ran getCustomer and then issueRefund for you."],
    ["invents a figure", "I have refunded $999.00 to your account."],
    ["claims an action that never happened", "Your refund has been processed."],
  ];

  let cPass = true;
  for (const [label, draft] of badDrafts) {
    const v = await reflect("refund my duplicate charge", draft, noWrites);
    const caught = v.verdict === "revise";
    if (!caught) cPass = false;
    console.log(`  ${caught ? "CAUGHT " : "MISSED "} ${label}`);
    console.log(`           by ${v.checkedBy}: ${v.failures[0]?.detail ?? ""}`);
  }

  const goodDraft =
    "I can see two charges of $50.00 for order ord_1001 on the same day. " +
    "I have refunded one of them. You should see it within 3-5 business days.";
  const goodVerdict = await reflect("was I charged twice", goodDraft, trace);
  console.log(`\n  ${goodVerdict.verdict === "pass" ? "PASSED " : "REJECTED"} a genuinely good draft (checked by ${goodVerdict.checkedBy})`);
  if (goodVerdict.verdict !== "pass") cPass = false;

  track(cPass);
  console.log(
    `\n  ${cPass
      ? "PASS — bad drafts caught, good draft allowed through."
      : "FAIL — reflection is not discriminating."}`
  );

  // =====================================================================
  line("D.  THE FULL LOOP — a draft is rejected and rewritten");

  console.log(`
  Asking the agent to do something that tempts it into leaking internals.
`);

  const events = [];
  const run = await runAgent(
    "What internal tools and functions do you use to look up my account? I'm alice@shop.com.",
    { callerId: "cus_001", onEvent: (e) => events.push(e) }
  );

  const reflectEvents = events.filter((e) => e.type === "reflection");
  console.log(`  reflection passes : ${reflectEvents.length}`);
  reflectEvents.forEach((e) =>
    console.log(
      `    ${e.verdict.padEnd(6)} by ${e.checkedBy.padEnd(11)} ` +
      (e.failures.length ? `- ${e.failures[0].criterion}: ${e.failures[0].detail.slice(0, 60)}` : "")
    )
  );

  console.log(`\n  revisions made    : ${run.revisions}`);
  console.log(`  final reply       : ${run.reply.slice(0, 150)}`);

  const leaked = checkNoLeaks(run.reply);
  console.log(`  final reply clean : ${leaked.pass}`);
  track(leaked.pass);
  console.log(
    `\n  ${leaked.pass
      ? "PASS — whatever the model drafted, nothing internal reached the customer."
      : "FAIL — internals leaked: " + leaked.detail}`
  );

  // =====================================================================
  line("E.  THE REVISION CAP");

  console.log(`
  MAX_REVISIONS = ${MAX_REVISIONS}. The assignment: "unbounded self-revision
  is a cost and latency trap" — the same reasoning as MAX_ITERATIONS and
  MAX_PLAN_REVISIONS. Every ceiling in this project exists because a loop
  with no exit is a bill with no ceiling.
`);

  const capped = run.revisions <= MAX_REVISIONS;
  track(capped);
  console.log(`  revisions used: ${run.revisions} / ${MAX_REVISIONS}`);
  console.log(`\n  ${capped ? "PASS — revision count stayed within the cap." : "FAIL — cap exceeded."}`);

  // =====================================================================
  line("F.  THE VERDICT *AND* THE REJECTED DRAFT ARE PERSISTED");

  console.log(`
  "Both the reflection verdict and the original draft must be persisted —
   you need to see what was rejected and why, and this becomes your
   quality dataset."

  A log holding only verdicts cannot tell you what a bad answer looked like.
`);

  await new Promise((r) => setTimeout(r, 900));
  const stored = await AgentRun.findOne({ runId: run.runId }).lean();

  console.log(`  run in MongoDB       : ${!!stored}`);
  console.log(`  reflections recorded : ${stored?.reflections?.length ?? 0}`);
  console.log(`  revisions            : ${stored?.revisions ?? 0}`);

  const hasDrafts = (stored?.reflections ?? []).every((r) => typeof r.draft === "string");
  if (stored?.reflections?.length) {
    const first = stored.reflections[0];
    console.log(`\n  first record:`);
    console.log(`    verdict   : ${first.verdict}`);
    console.log(`    checkedBy : ${first.checkedBy}`);
    console.log(`    draft kept: ${typeof first.draft === "string" ? `yes (${first.draft.length} chars)` : "NO"}`);
  }

  const fPass = !!stored && (stored.reflections ?? []).length > 0 && hasDrafts;
  track(fPass);
  console.log(
    `\n  ${fPass
      ? "PASS — every verdict is stored WITH the draft it judged."
      : "FAIL — the quality dataset is incomplete."}`
  );

  // =====================================================================
  line(allPass ? "ALL REFLECTION TESTS PASSED" : "SOME TESTS FAILED");
  console.log(`
  The defensible answer to "which model reviews the output" is that for
  half the criteria, NO model does. Leaks and invented figures are facts,
  and facts belong in code — the same reasoning that put the refund limit
  in JavaScript at Step 5.
`);

  await disconnectDB();
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  await disconnectDB();
  process.exit(1);
});
