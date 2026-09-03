/**
 * planner.js
 *
 * Deciding whether to plan, producing the plan, and revising it when reality
 * disagrees.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN DECISION THE ASSIGNMENT ASKS US TO DEFEND
 * ---------------------------------------------------------------------------
 *
 *   "Which requests need a plan at all? Planning costs latency and tokens;
 *    'where's my order' doesn't need one. Where's your threshold, and how is
 *    it determined?"
 *
 * A plan costs one extra LLM call BEFORE any work starts - roughly a second of
 * latency and a few hundred tokens, on every request that gets one. Getting the
 * threshold wrong is expensive in both directions:
 *
 *   plan everything -> every trivial question is slower and dearer, and the
 *                      plan for "where's my order" is a one-line plan that
 *                      helped nobody
 *   plan nothing    -> complex requests improvise, and improvisation is where
 *                      an agent forgets to check eligibility before refunding
 *
 * OUR THRESHOLD: plan when the request needs MORE THAN ONE ACT.
 *
 * Not "more than one tool call" - a lookup that happens to need a customer ID
 * first is still one act. The distinction is whether the request contains
 * multiple things a human would call separate jobs.
 *
 *   "where is my order"                     one act   -> no plan
 *   "was I charged twice"                   one act   -> no plan
 *   "refund the duplicate AND tell me why"  two acts  -> plan
 *   "check X, then if Y do Z"               ordered   -> plan
 *
 * HOW IT IS DETERMINED - two stages, cheap one first:
 *
 *   1. A CODE classifier. Free, instant, deterministic. Catches the obvious
 *      cases at both ends: a short question with no conjunction is simple; a
 *      request naming an irreversible action alongside anything else is not.
 *   2. An LLM classifier, ONLY for what stage 1 cannot decide.
 *
 * Most traffic never reaches stage 2. That matters: a classifier that costs an
 * LLM call to decide whether to spend an LLM call has spent it either way.
 */

const { callLLM } = require("../llm/llmClient");

/** Revising forever is the same trap as reflecting forever. */
const MAX_PLAN_REVISIONS = 2;

// ---------------------------------------------------------------------------
// Stage 1 — the free classifier
// ---------------------------------------------------------------------------

/**
 * Signals that a request contains more than one act.
 *
 * These are deliberately conservative. A false NEGATIVE here is cheap - the
 * agent handles it reactively, as it did through all of Build 1. A false
 * POSITIVE costs latency on every trivial question, which users feel.
 */
const MULTI_ACT = [
  /\band then\b/i,
  /\bafter that\b/i,
  /\bfollowed by\b/i,
  /\bonce you\b/i,
  /\bif .* then\b/i,
  // "refund it and explain why" - a conjunction joining two verbs
  /\b(refund|credit|escalate|cancel)\b[^.?!]*\b(and|also|plus)\b[^.?!]*\b(tell|explain|why|confirm|send|check)\b/i,
  /\b(tell|explain)\s+me\s+(why|how|what happened)\b/i,
];

/** A request naming an irreversible action deserves a plan on its own. */
const IRREVERSIBLE = /\b(refund|reimburse|money back|charge ?back)\b/i;

/** Very short, single-clause questions are almost never multi-step. */
function looksTrivial(message) {
  const words = message.trim().split(/\s+/).length;
  const clauses = message.split(/[.?!;]|,\s*(?:and|then|also)\b/i).filter((c) => c.trim()).length;
  return words <= 12 && clauses <= 1;
}

/**
 * Decide whether this request needs a plan.
 *
 * @returns {{ needsPlan: boolean, reason: string, decidedBy: "code"|"llm" }}
 */
async function classifyRequest(message, { model } = {}) {
  const text = String(message || "");

  // --- obviously simple ---------------------------------------------------
  if (looksTrivial(text) && !IRREVERSIBLE.test(text)) {
    return {
      needsPlan: false,
      reason: "Short single-clause question with no irreversible action.",
      decidedBy: "code",
    };
  }

  // --- obviously multi-act ------------------------------------------------
  const hit = MULTI_ACT.find((re) => re.test(text));
  if (hit) {
    return {
      needsPlan: true,
      reason: "Request joins two or more distinct acts.",
      decidedBy: "code",
    };
  }

  // --- irreversible + anything else --------------------------------------
  // A refund alone is one act and the reactive loop handles it fine. A refund
  // wrapped in a longer request usually is not.
  if (IRREVERSIBLE.test(text) && text.trim().split(/\s+/).length > 18) {
    return {
      needsPlan: true,
      reason: "Irreversible action inside a longer, compound request.",
      decidedBy: "code",
    };
  }

  // --- genuinely ambiguous: ask the model --------------------------------
  //
  // Only requests that reach here cost an extra call, and the prompt is
  // deliberately tiny - we want a word back, not an essay.
  try {
    const verdict = await callLLM({
      model,
      messages: [
        {
          role: "system",
          content:
            "You classify customer support requests. Answer with exactly one " +
            "word: MULTI if the request requires several distinct actions " +
            "(look something up AND take an action, or do X then Y), or " +
            "SIMPLE if it is a single question or a single action. Answer " +
            "with one word only.",
        },
        { role: "user", content: text },
      ],
    });

    const answer = String(verdict.content || "").trim().toUpperCase();
    return {
      needsPlan: answer.startsWith("MULTI"),
      reason: `Classifier judged the request ${answer.startsWith("MULTI") ? "multi-step" : "single-step"}.`,
      decidedBy: "llm",
    };
  } catch (err) {
    // Fail toward NOT planning. The reactive loop is the behaviour we have
    // shipped and tested since Build 1; refusing to answer because the
    // classifier is unavailable would be a worse outcome than skipping a plan.
    console.warn(`[planner] classification failed (${err.message}) — skipping plan.`);
    return {
      needsPlan: false,
      reason: "Classifier unavailable; defaulted to the reactive loop.",
      decidedBy: "code",
    };
  }
}

// ---------------------------------------------------------------------------
// Producing a plan
// ---------------------------------------------------------------------------

const PLAN_PROMPT = `You produce short execution plans for a customer support agent.

Given the customer's request and the tools available, return a JSON object:

{
  "steps": [
    { "step": 1, "action": "what this step achieves, in plain language",
      "tool": "toolName or null if no tool is needed",
      "expected": "what a successful result looks like" }
  ]
}

Rules:
- 2 to 6 steps. If it genuinely needs one step, return one.
- Name a real tool from the list, or null.
- Order matters: later steps may depend on earlier results.
- Do not include steps for things you cannot do.
- Return ONLY the JSON object, no prose, no markdown fences.`;

/**
 * Ask the model for an ordered plan.
 *
 * @returns {Promise<{steps: Array, raw: string}|null>} null if unusable
 */
async function makePlan(message, tools, { model } = {}) {
  const toolList = tools
    .map((t) => `- ${t.function.name}: ${t.function.description.slice(0, 110)}`)
    .join("\n");

  const reply = await callLLM({
    model,
    messages: [
      { role: "system", content: `${PLAN_PROMPT}\n\nAvailable tools:\n${toolList}` },
      { role: "user", content: message },
    ],
  });

  return parsePlan(reply.content);
}

/**
 * Parse a plan out of whatever the model returned.
 *
 * A model asked for "only JSON" will still sometimes wrap it in a markdown
 * fence or add a sentence of preamble. Stripping fences and extracting the
 * outermost braces costs three lines and removes a whole class of failure.
 *
 * Returns null rather than throwing: a bad plan should degrade to the reactive
 * loop, never break the request.
 */
function parsePlan(content) {
  if (!content) return null;

  let text = String(content).trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;

    return {
      steps: parsed.steps.slice(0, 6).map((s, i) => ({
        step: i + 1,
        action: String(s.action ?? "").slice(0, 200),
        tool: s.tool && s.tool !== "null" ? String(s.tool) : null,
        expected: String(s.expected ?? "").slice(0, 200),
        status: "pending",
      })),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Replanning
// ---------------------------------------------------------------------------

/**
 * Should the remaining plan be revised?
 *
 * The assignment: "when a step fails or returns something unexpected, the agent
 * revises the remaining plan rather than blindly continuing."
 *
 * "Unexpected" is doing real work in that sentence, and it is NOT the same as
 * "failed". A tool can succeed and still invalidate the plan:
 *
 *   checkRefundEligibility -> ok, eligible: FALSE
 *
 * That call worked perfectly. Every remaining step - issue the refund, confirm
 * it - is now wrong. A replan trigger that only watches for errors would march
 * straight past it.
 */
function shouldReplan(toolCalls) {
  for (const call of toolCalls ?? []) {
    // A hard failure, other than ones the agent can simply retry.
    if (!call.ok) {
      const code = call.result?.error;
      if (code && !["invalid_arguments", "invalid_json"].includes(code)) {
        return {
          replan: true,
          why: `${call.name} returned ${code}`,
        };
      }
    }

    // A SUCCESSFUL result that contradicts the plan's assumption.
    if (call.ok && call.result && typeof call.result === "object") {
      if (call.result.eligible === false) {
        return {
          replan: true,
          why: `${call.name} found the order is not eligible: ${call.result.policyRule ?? "policy"}`,
        };
      }
      if (call.result.found === 0) {
        return {
          replan: true,
          why: `${call.name} found nothing relevant`,
        };
      }
    }
  }
  return { replan: false };
}

/**
 * Revise the remaining steps in light of what actually happened.
 *
 * Completed steps are immutable - they already happened, and rewriting history
 * would make the revision log a lie.
 */
async function revisePlan(plan, message, whatHappened, tools, { model } = {}) {
  const done = plan.steps.filter((s) => s.status === "done");
  const remaining = plan.steps.filter((s) => s.status !== "done");

  const toolList = tools.map((t) => `- ${t.function.name}`).join("\n");

  const reply = await callLLM({
    model,
    messages: [
      {
        role: "system",
        content:
          `${PLAN_PROMPT}\n\nAvailable tools:\n${toolList}\n\n` +
          "You are REVISING an existing plan because something unexpected " +
          "happened. Return only the steps that still need doing, renumbered " +
          "from 1. If nothing further can usefully be done, return a single " +
          "step explaining what you will tell the customer.",
      },
      {
        role: "user",
        content:
          `Original request: ${message}\n\n` +
          `Completed steps:\n${done.map((s) => `  ${s.step}. ${s.action} — done`).join("\n") || "  (none)"}\n\n` +
          `Steps that were still planned:\n${remaining.map((s) => `  ${s.action}`).join("\n")}\n\n` +
          `What happened: ${whatHappened}`,
      },
    ],
  });

  const revised = parsePlan(reply.content);
  if (!revised) return null;

  // Keep the completed steps, renumber the new ones after them.
  return {
    steps: [
      ...done,
      ...revised.steps.map((s, i) => ({ ...s, step: done.length + i + 1 })),
    ],
  };
}

module.exports = {
  classifyRequest,
  makePlan,
  revisePlan,
  shouldReplan,
  parsePlan,
  MAX_PLAN_REVISIONS,
};
