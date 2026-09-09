/**
 * test-router-matrix.js
 *
 * The test that should have existed before any of the routing bugs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Every routing bug in this project was found by a HUMAN USING THE APP:
 *
 *   "Hey"                      -> refused as off-topic
 *   "alice@shop.com"           -> swallowed, agent greeted again forever
 *   "who is pm of india?"      -> ANSWERED, because the previous agent turn
 *                                 ended in "anything else?" and the
 *                                 continuation guard jumped the scope check
 *
 * Not one of them was caught by a test, because there was no test that fed
 * the router a message TOGETHER WITH a conversation history. Routing is
 * stateful and every test treated it as stateless.
 *
 * The rule this encodes: routing decisions depend on (message, history), so
 * the test matrix must be over pairs, not messages.
 *
 *   node test-router-matrix.js
 */

require("dotenv").config();

const { connectDB } = require("./src/db/connection");
const { routeRequest } = require("./src/agent/router");

// ---------------------------------------------------------------------------
// Histories - the second half of every routing decision
// ---------------------------------------------------------------------------

const FRESH = [];

/** The agent asked for information and is waiting for it. */
const ASKED_FOR_EMAIL = [
  { role: "user", content: "check my orders" },
  {
    role: "assistant",
    content:
      "Sure thing. Could you please provide the email address linked to " +
      "your account? Once I have that, I can look up your orders.",
  },
];

/**
 * The agent CLOSED a topic with a pleasantry that happens to end in "?".
 *
 * This is the history that broke everything. It looks like a question to a
 * naive check, so a continuation guard fires and skips the scope patterns.
 */
const CLOSED_WITH_PLEASANTRY = [
  { role: "user", content: "thanks" },
  { role: "assistant", content: "You're very welcome. Anything else I can help with?" },
];

/** A plain statement - no question anywhere. */
const STATEMENT = [
  { role: "user", content: "where is ord_1001" },
  { role: "assistant", content: "Your order ord_1001 was delivered on 28 August." },
];

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------
//
// `want` is the route or workflow name we require. Deliberately loose about
// WHICH agent route (guided vs autonomous) in most cases - that is a cost
// decision the classifier is allowed to change its mind about. What must never
// drift is the SAFETY-relevant answer: refused vs not refused.

const CASES = [
  // ---- off-topic must be refused in EVERY conversational position --------
  ["off-topic, fresh", "who is the PM of India?", FRESH, "out_of_scope"],
  [
    "off-topic, after a closing pleasantry",
    "who is pm of india? where is my refund?",
    CLOSED_WITH_PLEASANTRY,
    "out_of_scope",
  ],
  [
    "off-topic, while the agent waits for an email",
    "write me a poem about the sea",
    ASKED_FOR_EMAIL,
    "out_of_scope",
  ],
  ["off-topic, after a statement", "teach me python recursion", STATEMENT, "out_of_scope"],

  // ---- greetings must NOT be refused ------------------------------------
  ["greeting, fresh", "Hey", FRESH, "social"],
  ["name, fresh", "My name is alice", FRESH, "social"],
  ["thanks, after a statement", "thanks", STATEMENT, "social"],

  // ---- an ANSWER must reach the agent, never a template -----------------
  ["email answering the question", "alice@shop.com", ASKED_FOR_EMAIL, "agent"],
  ["email with words around it", "here's my mail alice@shop.com", ASKED_FOR_EMAIL, "agent"],
  ["order id as an answer", "ord_1001", ASKED_FOR_EMAIL, "agent"],

  // ---- the cheap path must stay cheap -----------------------------------
  ["order lookup, fresh", "where is order ord_1001?", FRESH, "order_status"],
  ["bare order id, fresh", "ord_1001?", FRESH, "order_status_bare"],

  // ---- real support requests reach an agent -----------------------------
  ["refund request", "refund the duplicate charge on ord_1001", FRESH, "agent"],
  ["invoice question", "can you show me my invoices?", FRESH, "agent"],
  ["policy question", "how long do I have to request a refund?", FRESH, "agent"],
  [
    "follow-up after a statement",
    "it has passed 5 days and I still cannot see it",
    STATEMENT,
    "agent",
  ],
];

/** Map a routing result onto the coarse category the matrix asserts on. */
function categorise(r) {
  if (r.workflow === "out_of_scope") return "out_of_scope";
  if (r.workflow === "social") return "social";
  if (r.workflow) return r.workflow; // order_status, order_status_bare
  return "agent"; // guided | autonomous | specialist - all reach a model
}

(async () => {
  await connectDB();

  console.log("=".repeat(74));
  console.log("ROUTER MATRIX - (message x conversation state)");
  console.log("=".repeat(74));
  console.log(
    "\nRouting is stateful. Every bug in this area came from testing it as\n" +
      "though it were not, so every case here carries a history.\n"
  );

  let pass = 0;
  const failures = [];

  for (const [label, message, history, want] of CASES) {
    const r = await routeRequest(message, { history });
    const got = categorise(r);
    const ok = got === want;

    if (ok) pass++;
    else failures.push({ label, message, want, got, stage: r.stage });

    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(42)} ${got.padEnd(18)} ${
        ok ? "" : `(wanted ${want})`
      }`
    );
  }

  console.log("\n" + "=".repeat(74));
  console.log(`${pass} / ${CASES.length} passed`);
  console.log("=".repeat(74));

  if (failures.length > 0) {
    console.log("\nFAILURES\n");
    for (const f of failures) {
      console.log(`  ${f.label}`);
      console.log(`    message : ${JSON.stringify(f.message)}`);
      console.log(`    wanted  : ${f.want}`);
      console.log(`    got     : ${f.got}  (stage: ${f.stage})`);
      console.log("");
    }
    console.log(
      "The safety-relevant rows are the out_of_scope ones. A support agent\n" +
        "that answers general knowledge because its own last sentence ended in\n" +
        "a question mark has no scope guard at all.\n"
    );
    process.exit(1);
  }

  console.log(
    "\n  Off-topic is refused from every conversational position, greetings\n" +
      "  are never refused, and an answer to a question always reaches the\n" +
      "  agent that asked it.\n"
  );
  process.exit(0);
})().catch((err) => {
  console.error("\nMatrix threw:", err);
  process.exit(1);
});
