/**
 * test-multiagent.js
 *
 * Build 3, part 1: does the multi-agent layer do what it claims?
 *
 * The claims worth testing are not "does it produce an answer" - that is easy
 * and proves nothing. They are:
 *
 *   A  Tool isolation is a WALL, not a rule
 *   B  KB isolation is a wall too
 *   C  The coordinator routes to the right specialist
 *   D  A two-domain request is recognised as two domains
 *   E  Delegation is capped
 *   F  A specialist can still pause for approval (the core still works)
 */

require("dotenv").config();

const { connectDB } = require("./src/db/connection");
const vectorStore = require("./src/rag/vectorStore");
const { SPECIALISTS, getSpecialist } = require("./src/agents/specialists");
const {
  decideDelegation,
  buildBrief,
  MAX_DELEGATIONS,
} = require("./src/agents/coordinator");
const { runCoordinator } = require("./src/agents/coordinator");
const { getToolDefinitions } = require("./src/tools/toolRegistry");

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? " - " + detail : ""}`);
  ok ? pass++ : fail++;
}

// ---------------------------------------------------------------------------

async function testToolIsolation() {
  console.log("\nA. Tool isolation - can a specialist reach a tool it should not?");

  const all = getToolDefinitions().map((t) => t.function.name);
  console.log(`     the full toolbox has ${all.length} tools`);

  for (const [name, spec] of Object.entries(SPECIALISTS)) {
    const unknown = spec.tools.filter((t) => !all.includes(t));
    check(
      `${name}: every listed tool actually exists`,
      unknown.length === 0,
      unknown.length ? `unknown: ${unknown.join(", ")}` : `${spec.tools.length} tools`
    );
  }

  // The specific claim the assignment makes.
  const billing = getSpecialist("billing");
  const technical = getSpecialist("technical");

  check(
    "technical cannot issue a refund",
    !technical.tools.includes("issueRefund"),
    "compensation is a billing decision, so it passes refund policy"
  );
  check(
    "technical cannot apply a credit",
    !technical.tools.includes("applyAccountCredit")
  );
  // THE assignment's own claim, now actually testable.
  //
  // Until Build 3 this could not be checked: every write tool we owned moved
  // money, so there was no account action to withhold from billing. Adding
  // changePlan is what turned this from rhetoric into an assertion.
  const account = getSpecialist("account");
  check(
    "the account specialist CAN change a plan",
    account.tools.includes("changePlan"),
    "otherwise the next check proves nothing"
  );
  check(
    "the billing specialist CANNOT change a plan",
    !billing.tools.includes("changePlan"),
    "not discouraged - never shown the tool"
  );
  check(
    "the research specialist has NO write tools at all",
    !["issueRefund", "applyAccountCredit", "changePlan", "escalateToHuman"].some(
      (t) => getSpecialist("research").tools.includes(t)
    ),
    "read-only by construction, not by instruction"
  );

  // Every specialist should be strictly smaller than the full set. A
  // "specialist" with all 8 tools is just the general agent with a costume on.
  for (const [name, spec] of Object.entries(SPECIALISTS)) {
    check(
      `${name} is genuinely restricted (${spec.tools.length} < ${all.length})`,
      spec.tools.length < all.length
    );
  }
}

// ---------------------------------------------------------------------------

async function testKbIsolation() {
  console.log("\nB. KB isolation - can billing retrieve the account policy?");

  await vectorStore.connectVectorStore();
  const total = await vectorStore.count();
  console.log(`     ${total} documents indexed`);

  if (total === 0) {
    console.log("     SKIP - no documents indexed. Run `node index-kb.js` first.");
    return;
  }

  // Ask, in the plainest possible terms, for a document that lives in the
  // "accounts" category. Billing must not be able to see it.
  const query = "how do I close my account and delete my data";

  const asBilling = await vectorStore.search(query, 3, {
    categories: SPECIALISTS.billing.kbCategories,
  });
  const asAccount = await vectorStore.search(query, 3, {
    categories: SPECIALISTS.account.kbCategories,
  });
  const unfiltered = await vectorStore.search(query, 3);

  const titles = (r) => r.results.map((d) => d.title);
  console.log(`     unfiltered  -> ${titles(unfiltered).join(" | ")}`);
  console.log(`     as account  -> ${titles(asAccount).join(" | ")}`);
  console.log(`     as billing  -> ${titles(asBilling).join(" | ")}`);

  check(
    "the account-deletion doc exists and is findable",
    titles(unfiltered).some((t) => /deletion/i.test(t)),
    "otherwise this whole test proves nothing"
  );
  check(
    "the account specialist CAN see it",
    titles(asAccount).some((t) => /deletion/i.test(t))
  );
  check(
    "the billing specialist CANNOT see it",
    !titles(asBilling).some((t) => /deletion/i.test(t)),
    "a wall, not a rule"
  );
  check(
    "billing's results are all inside its own categories",
    asBilling.results.every((d) =>
      SPECIALISTS.billing.kbCategories.includes(d.category)
    ),
    asBilling.results.map((d) => d.category).join(",")
  );
}

// ---------------------------------------------------------------------------

async function testRouting() {
  console.log("\nC. Coordinator routing - does the right desk get the request?");

  const cases = [
    ["I was charged twice for ord_1001, please refund the duplicate", "billing"],
    ["my package says delivered but it never arrived", "technical"],
    ["I want to upgrade my plan to Pro", "account"],
    ["are Pro customers churning more than last quarter and why", "research"],
  ];

  for (const [message, expected] of cases) {
    const d = await decideDelegation(message);
    check(
      `"${message.slice(0, 42)}..." -> ${expected}`,
      d.specialists.includes(expected),
      `got [${d.specialists.join(", ")}] (${d.mode}, ${d.latencyMs}ms)`
    );
  }
}

// ---------------------------------------------------------------------------

async function testMultiDomain() {
  console.log("\nD. Multi-domain - the assignment's own example");

  const message = "My subscription didn't renew and I was charged anyway";
  const d = await decideDelegation(message);

  console.log(`     -> [${d.specialists.join(", ")}] mode=${d.mode}`);
  console.log(`     reason: ${d.reason}`);
  for (const [k, v] of Object.entries(d.tasks ?? {})) {
    console.log(`     task[${k}]: ${v}`);
  }

  check(
    "recognised as spanning two specialists",
    d.specialists.length === 2,
    `got ${d.specialists.length}`
  );
  check(
    "both account and billing are involved",
    d.specialists.includes("account") && d.specialists.includes("billing")
  );
  check(
    "run sequentially, not in parallel",
    d.mode === "sequential",
    "billing cannot judge the charge until account says whether it lapsed"
  );

  // The handoff contract itself.
  const brief = buildBrief(
    SPECIALISTS.billing,
    d.tasks?.billing ?? "check the charge",
    message,
    [{ from: "account", answer: "The subscription lapsed on 12 March." }]
  );
  console.log("\n     --- the brief billing receives ---");
  console.log(brief.split("\n").map((l) => "     " + l).join("\n"));

  check(
    "the brief carries the customer's verbatim words",
    brief.includes(message),
    "a summary loses the actual question"
  );
  check(
    "the brief carries the earlier specialist's findings",
    brief.includes("lapsed on 12 March")
  );
  check(
    "the brief does NOT carry the full conversation history",
    !brief.includes("role"),
    "context cost vs information loss - we chose the brief"
  );
}

// ---------------------------------------------------------------------------

async function testCap() {
  console.log("\nE. Loop prevention - is delegation actually capped?");

  check(
    "a hard numeric cap exists",
    typeof MAX_DELEGATIONS === "number" && MAX_DELEGATIONS > 0,
    `MAX_DELEGATIONS = ${MAX_DELEGATIONS}`
  );

  // The coordinator's parser must refuse to return more than 2 specialists
  // even if the model asks for five. Prompt says so; code enforces it.
  const { decideDelegation: _d } = require("./src/agents/coordinator");
  const d = await _d(
    "refund me, fix my delivery, change my plan, and tell me about churn trends"
  );
  console.log(`     kitchen-sink request -> [${d.specialists.join(", ")}]`);
  check(
    "never more than 2 specialists, whatever the model says",
    d.specialists.length <= 2,
    `got ${d.specialists.length}`
  );
}

// ---------------------------------------------------------------------------

async function testCoreStillWorks() {
  console.log("\nF. The core still works inside a specialist");

  const result = await runCoordinator(
    "I'm alice@shop.com - please refund $55 on ord_1001, it was a duplicate charge",
    { callerId: "cus_001" }
  );

  console.log(`     status      : ${result.status}`);
  console.log(`     specialists : ${result.multiAgent?.specialists?.join(", ")}`);
  console.log(`     tokens      : ${result.tokensUsed}`);

  check(
    "a write tool still pauses for confirmation inside a specialist",
    result.status === "awaiting_confirmation",
    result.status === "awaiting_confirmation"
      ? `paused by ${result.multiAgent?.pausedBy}`
      : `got "${result.status}" - the model may have answered instead`
  );

  if (result.status === "awaiting_confirmation") {
    check(
      "the paused state still carries the caller's badge",
      result.callerId === "cus_001",
      "without this the approved write runs unauthenticated"
    );
    check(
      "the paused state carries the specialist's KB slice",
      Array.isArray(result.kbCategories),
      `kbCategories = ${JSON.stringify(result.kbCategories)}`
    );
  }
}

// ---------------------------------------------------------------------------

(async () => {
  console.log("=".repeat(70));
  console.log("BUILD 3 - MULTI-AGENT");
  console.log("=".repeat(70));

  await connectDB();

  await testToolIsolation();
  await testKbIsolation();
  await testRouting();
  await testMultiDomain();
  await testCap();
  await testCoreStillWorks();

  console.log("\n" + "=".repeat(70));
  console.log(`${pass} passed, ${fail} failed`);
  console.log("=".repeat(70));
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\nTest run threw:", err);
  process.exit(1);
});
