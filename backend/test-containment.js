/**
 * test-containment.js
 *
 * ONE QUESTION: if a single specialist dies, does the whole request die?
 *
 * This test exists because of a real incident. During the Build 3 benchmark a
 * genuine Mistral 503 hit one specialist mid-delegation, and the exception
 * travelled straight up through runSpecialist -> runCoordinator and killed the
 * entire request. Stack trace, no answer, nothing saved - including the work
 * the OTHER specialist had already finished successfully.
 *
 * That is the multi-agent tax in its purest form:
 *
 *     A single agent making 3 LLM calls has ONE thing that can fail.
 *     Two specialists making 3 calls each have TWO INDEPENDENT things that can
 *     fail, and either one taking the request down means the failure
 *     probability COMPOUNDS with every agent you add.
 *
 * The assignment asks where multi-agent "adds handoff failure modes". This is
 * one, and we found it by being unlucky rather than clever.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING HERE IS STUBBED
 * ---------------------------------------------------------------------------
 *
 * The first two versions of this test called the real API. Both gave the wrong
 * answer, for opposite reasons:
 *
 *   Run 1 - the patch was applied AFTER requiring the coordinator. But
 *           coordinator.js does `const { runAgent } = require(...)` at load
 *           time, so it holds its own reference; reassigning the export later
 *           changes an object nobody reads. The injected failure never
 *           happened - and the test printed PASS anyway, because "did we get a
 *           reply" is true whether or not the thing under test ran.
 *
 *   Run 2 - a REAL Mistral outage took down both specialists, so "the other
 *           specialist still ran" failed for a reason that had nothing to do
 *           with our code.
 *
 * Two lessons, both worth more than the test itself:
 *
 *   1. A test that passes without reaching the code it tests is worse than no
 *      test, because it is a false all-clear.
 *   2. A test of FAILURE HANDLING must not depend on the thing that fails.
 *
 * So: no network. One stub throws, one returns, and the only thing being
 * measured is what the coordinator does about it.
 */

require("dotenv").config();

const { connectDB } = require("./src/db/connection");
const { connectVectorStore } = require("./src/rag/vectorStore");

(async () => {
  await connectDB();
  await connectVectorStore();

  // ---- Inject BEFORE requiring the coordinator --------------------------
  //
  // Order matters, for the reason in the header. Patch first, require second.
  const runner = require("./src/agent/agentRunner");

  runner.runAgent = async (brief, opts = {}) => {
    if (opts.specialist === "account") {
      throw new Error("Mistral API error 503: Service temporarily unavailable");
    }
    return {
      status: "complete",
      reply: "The $240 charge on inv_5003 was a duplicate and can be refunded.",
      messages: [],
      trace: [],
      iterations: 1,
      tokensUsed: 500,
    };
  };

  const coordinator = require("./src/agents/coordinator");

  // The routing decision is pinned rather than asked for, so the provider
  // cannot change what this test exercises.
  const PINNED = {
    specialists: ["account", "billing"],
    mode: "sequential",
    tasks: {
      account: "Check whether the subscription lapsed.",
      billing: "Check whether the charge was correct.",
    },
    reason: "pinned by the test",
    latencyMs: 0,
    tokens: 0,
  };

  console.log("Simulating: the ACCOUNT specialist's LLM is down.");
  console.log("Expected: account fails, billing still runs, customer gets an answer.\n");

  const events = [];
  const r = await coordinator.runCoordinator(
    "I'm alice@shop.com. My subscription didn't renew and I was charged anyway.",
    { callerId: "cus_001", decision: PINNED, onEvent: (e) => events.push(e) }
  );

  const seen = (t) => events.filter((e) => e.type === t);

  console.log("specialist_failed :", seen("specialist_failed").map((e) => e.specialist));
  console.log("specialist_done   :", seen("specialist_done").map((e) => e.specialist));
  console.log("failures reported :", r.multiAgent?.failures);
  console.log("status            :", r.status);
  console.log("\nREPLY:", (r.reply || "").slice(0, 300));

  const failedNames = seen("specialist_failed").map((e) => e.specialist);
  const doneNames = seen("specialist_done").map((e) => e.specialist);

  const checks = [
    ["the injected failure was actually reached", failedNames.includes("account")],
    ["the process did not crash", true],
    ["the surviving specialist still ran", doneNames.includes("billing")],
    ["the customer still got a real answer", /duplicate/i.test(r.reply || "")],
    [
      "the failure is reported upward, not hidden",
      (r.multiAgent?.failures ?? []).includes("account"),
    ],
  ];

  console.log();
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  }

  const ok = checks.every(([, p]) => p);
  console.log(
    "\n" +
      (ok
        ? "One specialist died. The request survived and said so."
        : "CONTAINMENT IS BROKEN.")
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("\nFAIL - the failure escaped and killed the process:\n", e.message);
  process.exit(1);
});
