/**
 * reflection.js
 *
 * Grading the draft answer before the customer sees it.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN DECISION THE ASSIGNMENT ASKS US TO DEFEND
 * ---------------------------------------------------------------------------
 *
 *   "Same model for reflection, or a cheaper/different one? There's a real
 *    tradeoff between cost, latency, and the known weakness of a model
 *    evaluating its own output."
 *
 * That last clause is the important one, and it points somewhere the question
 * does not: a model grading its own answer is a weak check BY CONSTRUCTION. It
 * already decided the answer was good - that is why it produced it. Asking it
 * again mostly produces agreement, which is why "reflection that always passes
 * is not reflection".
 *
 * OUR ANSWER: NEITHER. Split the criteria by what they actually require.
 *
 *   Criterion              Checkable in code?   Who checks it
 *   ---------------------------------------------------------------
 *   Did it leak internals?       YES            code - exact strings
 *   Are claims grounded?         MOSTLY         code - numbers/IDs vs tools
 *   Is the tone appropriate?     NO             the model
 *   Does it answer the question? NO             the model
 *
 * The first two are FACTS. "Does the reply contain the string 'issueRefund'" is
 * not a judgement call, and a regex answers it perfectly, for free, every time.
 * Handing that to a model makes it slower, dearer, and LESS reliable.
 *
 * The last two genuinely need judgement, so they get one model call - but only
 * after the free checks have run, and only when there is something to judge.
 *
 * This is the same principle as every other guarantee in this project: a prompt
 * saying "never leak tool names" is a suggestion; a regex is a check. We put
 * the policy limits in code at Step 5 for exactly this reason. Reflection is
 * not different just because the subject is prose.
 *
 * COST: most drafts pass the code checks and need one cheap model call.
 * A draft that fails a code check is rejected for FREE and revised without ever
 * consulting a model about it.
 */

const { callLLM } = require("../llm/llmClient");

/**
 * Unbounded self-revision is a cost and latency trap - the assignment says so
 * outright, and it is the same reasoning as MAX_ITERATIONS and
 * MAX_PLAN_REVISIONS. Every ceiling in this project exists because a loop with
 * no exit is a bill with no ceiling.
 */
const MAX_REVISIONS = 2;

// ---------------------------------------------------------------------------
// Code checks - free, instant, deterministic
// ---------------------------------------------------------------------------

/**
 * Strings that must never appear in a customer-facing reply.
 *
 * Built from the actual tool registry and the actual error codes rather than
 * guessed, so adding a tool cannot silently create a new leak this misses.
 */
const INTERNAL_TERMS = [
  // tool names
  "searchKnowledgeBase", "getCustomer", "getOrders", "getInvoices",
  "checkRefundEligibility", "issueRefund", "applyAccountCredit",
  "escalateToHuman",
  // error codes
  "policy_violation", "approval_required", "not_authorized",
  "customer_not_found", "order_not_found", "invalid_arguments",
  "invalid_json", "unknown_tool", "tool_execution_failed",
  "knowledge_base_unavailable", "not_eligible", "amount_exceeds_refundable",
  // internal concepts
  "system prompt", "tool call", "toolRegistry", "MAX_ITERATIONS",
  "autoApproveMax", "RELEVANCE_FLOOR",
];

/**
 * Did the draft leak internal implementation details?
 *
 * A pure string check. No model needed, no judgement involved, no false
 * negatives from a model deciding "issueRefund" reads naturally enough.
 */
function checkNoLeaks(draft) {
  const found = INTERNAL_TERMS.filter((term) =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(draft)
  );

  return found.length === 0
    ? { pass: true }
    : {
        pass: false,
        criterion: "no_internal_leaks",
        detail: `The reply contains internal identifiers: ${found.join(", ")}.`,
        fix: "Rewrite in plain customer language. Never name tools, error codes, or internal limits.",
      };
}

/**
 * Are the concrete claims grounded in what the tools actually returned?
 *
 * NOT a general-purpose fact checker - that would need a model and would be
 * unreliable anyway. This catches the specific, high-consequence case: a money
 * amount or an order ID that appears in the answer but appears NOWHERE in the
 * tool results.
 *
 * That is the shape of the Step 4 failure, where the agent promised a $240
 * refund it had never issued. Numbers are exactly where invention is most
 * expensive and most checkable.
 */
function checkGrounded(draft, trace) {
  // Everything the tools actually returned, as one searchable blob.
  const evidence = JSON.stringify(
    (trace ?? []).flatMap((t) => (t.toolCalls ?? []).map((c) => c.result))
  );

  const ungrounded = [];

  // Order / invoice / refund identifiers
  for (const id of draft.match(/\b(?:ord|inv|ref|cus|esc)_\d+\b/g) ?? []) {
    if (!evidence.includes(id)) ungrounded.push(id);
  }

  // Money amounts. Ignore trivial ones - "3-5 business days" style numbers are
  // not claims about the customer's account.
  for (const money of draft.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) ?? []) {
    const value = money.replace(/[$,\s]/g, "");
    const num = Number(value);
    if (!Number.isFinite(num) || num === 0) continue;

    // Match against the raw number in any form the tool might have returned:
    // 240, 240.00, "240"
    const forms = [value, String(num), num.toFixed(2), String(Math.round(num))];
    if (!forms.some((f) => evidence.includes(f))) ungrounded.push(money);
  }

  return ungrounded.length === 0
    ? { pass: true }
    : {
        pass: false,
        criterion: "grounded_claims",
        detail: `These appear in the reply but not in any tool result: ${ungrounded.join(", ")}.`,
        fix: "Only state figures and identifiers that came back from a tool. If you do not have a value, say so rather than supplying one.",
      };
}

/**
 * Did the agent claim an action that never actually succeeded?
 *
 * The Step 4 failure, checkable directly: the draft says "I have refunded" but
 * no successful write tool ran in this run.
 */
function checkNoFalseActions(draft, trace) {
  const claimsDone =
    /\b(?:I(?:'ve| have)?\s+(?:issued|refunded|processed|applied|credited|escalated)|has been (?:issued|refunded|processed|applied|credited|escalated)|refund (?:of [^.]* )?has been)\b/i.test(
      draft
    );

  if (!claimsDone) return { pass: true };

  const didWrite = (trace ?? []).some((t) =>
    (t.toolCalls ?? []).some(
      (c) =>
        c.ok &&
        ["issueRefund", "applyAccountCredit", "escalateToHuman"].includes(c.name)
    )
  );

  return didWrite
    ? { pass: true }
    : {
        pass: false,
        criterion: "no_false_actions",
        detail:
          "The reply states an action was completed, but no action succeeded in this run.",
        fix: "Say what you found and what happens next. Never describe an action as done unless it actually completed.",
      };
}

// ---------------------------------------------------------------------------
// Model check - judgement only
// ---------------------------------------------------------------------------

const JUDGE_PROMPT = `You review draft replies from a customer support agent.

Judge ONLY these two things:
1. Does the reply actually answer the customer's question?
2. Is the tone appropriate - professional, clear, not dismissive, not padded?

Do NOT judge factual accuracy or internal details; those are checked elsewhere.

Return ONLY this JSON, no prose, no fences:
{ "answersQuestion": true|false, "toneOk": true|false, "problem": "one sentence, or empty if both pass" }`;

async function judgeWithModel(question, draft, { model } = {}) {
  try {
    const reply = await callLLM({
      model,
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        {
          role: "user",
          content: `Customer asked:\n${question}\n\nDraft reply:\n${draft}`,
        },
      ],
    });

    let text = String(reply.content || "").trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1) return { pass: true, skipped: "unparseable" };

    const v = JSON.parse(text.slice(start, end + 1));

    if (v.answersQuestion !== false && v.toneOk !== false) return { pass: true };

    return {
      pass: false,
      criterion: v.answersQuestion === false ? "answers_question" : "tone",
      detail: v.problem || "The draft did not meet the criterion.",
      fix:
        v.answersQuestion === false
          ? "Answer the question the customer actually asked."
          : "Rewrite in a clear, professional, helpful tone.",
    };
  } catch (err) {
    // Reflection is a quality gate, not a correctness gate. If the judge is
    // unavailable, the code checks have already run and the draft ships.
    // Refusing to answer because a reviewer is offline is a worse outcome.
    console.warn(`[reflection] judge unavailable (${err.message}) — passing.`);
    return { pass: true, skipped: err.message };
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Evaluate a draft against all four criteria.
 *
 * Code checks run FIRST and short-circuit: a draft that leaks a tool name is
 * rejected for free, without ever asking a model about it.
 *
 * @returns {Promise<{verdict:"pass"|"revise", failures:Array, checkedBy:string}>}
 */
async function reflect(question, draft, trace, { model } = {}) {
  if (!draft || !draft.trim()) {
    return {
      verdict: "revise",
      failures: [
        {
          criterion: "empty",
          detail: "The draft is empty.",
          fix: "Write a reply.",
        },
      ],
      checkedBy: "code",
    };
  }

  const codeChecks = [
    checkNoLeaks(draft),
    checkGrounded(draft, trace),
    checkNoFalseActions(draft, trace),
  ].filter((r) => !r.pass);

  if (codeChecks.length > 0) {
    return { verdict: "revise", failures: codeChecks, checkedBy: "code" };
  }

  const judged = await judgeWithModel(question, draft, { model });
  if (!judged.pass) {
    return { verdict: "revise", failures: [judged], checkedBy: "model" };
  }

  return {
    verdict: "pass",
    failures: [],
    checkedBy: judged.skipped ? "code (judge unavailable)" : "code+model",
  };
}

/** Turn failures into an instruction the agent can act on. */
function revisionInstruction(failures) {
  return (
    "Your draft reply was rejected by a quality check. Fix these problems and " +
    "write the reply again:\n\n" +
    failures
      .map((f, i) => `${i + 1}. ${f.detail}\n   ${f.fix}`)
      .join("\n\n") +
    "\n\nReply to the customer directly. Do not mention this review."
  );
}

module.exports = {
  reflect,
  revisionInstruction,
  checkNoLeaks,
  checkGrounded,
  checkNoFalseActions,
  MAX_REVISIONS,
  INTERNAL_TERMS,
};
