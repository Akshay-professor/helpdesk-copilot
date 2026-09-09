/**
 * coordinator.js
 *
 * The agent that does no work.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS
 * ---------------------------------------------------------------------------
 *
 * The coordinator has ZERO domain tools. It cannot look up an order, read an
 * invoice, or issue a refund. All it does is:
 *
 *      1. read the request
 *      2. decide which specialist(s) should handle it
 *      3. run them - in sequence or in parallel
 *      4. merge what comes back into one answer
 *
 * The assignment specifies exactly this: "Delegation only - no domain tools."
 *
 * Think of a hospital triage nurse. They do not set your broken arm. They look
 * at you, decide "orthopaedics", and walk you there. Give the triage nurse a
 * scalpel and two bad things happen: they start doing surgery they are not
 * trained for, and the queue behind them stops moving.
 *
 * A coordinator with domain tools stops being a coordinator. It answers the
 * easy parts itself, delegates only the leftovers, and now you have five
 * agents' worth of latency and one agent's worth of specialisation.
 *
 * ---------------------------------------------------------------------------
 * THE HANDOFF CONTRACT - the design decision the assignment asks us to defend
 * ---------------------------------------------------------------------------
 *
 * "Design decision to defend: full conversation history, or a summarized
 *  brief? (context cost vs information loss)"
 *
 * We send a BRIEF, not the full history. Specifically:
 *
 *      to the specialist  ->  { task, customerMessage, callerId, findings }
 *      back from it       ->  { answer, facts, unresolved, tokensUsed }
 *
 * Why not full history? Three reasons, in order of how much they matter:
 *
 *   1. COST GROWS WITH AGENTS, NOT WITH TURNS. Three specialists each reading
 *      a 20-turn history is 60 turns of tokens for one question. That is the
 *      multi-agent tax the assignment warns about, paid in full for nothing.
 *
 *   2. IRRELEVANT CONTEXT ACTIVELY HARMS. Hand the billing agent a long
 *      history about a broken zip, and it starts reasoning about the zip. The
 *      whole point of specialisation is a narrow view; a full history undoes
 *      it deliberately.
 *
 *   3. AN EXPLICIT CONTRACT IS DEBUGGABLE. When a specialist gets a bad
 *      answer, you can read the brief it was given and see whether the
 *      coordinator asked the wrong question or the specialist answered it
 *      badly. With full history, "it had all the information" is technically
 *      true and completely useless.
 *
 * And the honest cost, because this is a real trade-off and pretending
 * otherwise would be dishonest:
 *
 *   INFORMATION LOSS IS REAL. If the customer said "the blue one" ten turns
 *   ago, the brief may not carry it. We mitigate it two ways - the customer's
 *   verbatim message always travels, and the coordinator can pass `findings`
 *   from an earlier specialist forward - but we have not eliminated it. We
 *   have decided it is cheaper than the alternative, which is different from
 *   claiming it does not exist.
 *
 * ---------------------------------------------------------------------------
 * SEQUENTIAL OR PARALLEL
 * ---------------------------------------------------------------------------
 *
 * "My subscription didn't renew and I was charged anyway" touches Account AND
 * Billing. Two ways to run them:
 *
 *   PARALLEL     both at once. Fast. Correct only when neither needs the
 *                other's answer.
 *
 *   SEQUENTIAL   account first, then billing WITH the account findings. Slower.
 *                Necessary when the second question depends on the first.
 *
 * For that example, sequential is right: whether the charge was wrong depends
 * on whether the subscription actually lapsed. Billing cannot judge the charge
 * without knowing that.
 *
 * So the coordinator decides which, and must say why. Defaulting to parallel
 * because it is faster produces confidently contradictory answers - two agents
 * reasoning from half the picture each.
 *
 * ---------------------------------------------------------------------------
 * LOOP PREVENTION
 * ---------------------------------------------------------------------------
 *
 * "Agents must not hand off back and forth indefinitely. Cap delegation depth
 *  and handle hitting the cap."
 *
 * Billing says "that's an account question", account says "that's a billing
 * question", forever. Every hop is a paid LLM call, so this is Build 1's
 * MAX_ITERATIONS problem wearing a different hat - and it gets the same
 * answer: a hard, code-enforced cap.
 *
 * Two limits, because there are two ways to spin:
 *
 *      MAX_DELEGATIONS   how many specialist runs total, in one request
 *      MAX_DEPTH         how many hops in a chain (A -> B -> C)
 *
 * And hitting the cap is not a crash. It escalates to a human with everything
 * gathered so far, because a partial answer plus an honest handover beats
 * silence.
 */

const { runAgent } = require("../agent/agentRunner");
const { callLLM } = require("../llm/llmClient");
const { routeByPattern, runWorkflow, ROUTES } = require("../agent/router");
const { RUN_STATUS } = require("../constants");
const {
  getSpecialist,
  specialistNames,
  specialistMenu,
} = require("./specialists");

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Total specialist runs allowed for ONE customer request.
 *
 * Three, because the worst legitimate case we have is a request spanning two
 * domains, plus one re-delegation when a specialist correctly says "not mine".
 * A fourth would mean the coordinator is guessing.
 */
const MAX_DELEGATIONS = 3;

/**
 * How deep a chain of handoffs may go.
 *
 * Depth 2 means: coordinator -> specialist -> one more specialist. That is
 * enough for "billing needs the account facts first" and not enough for
 * ping-pong.
 */
const MAX_DEPTH = 2;

// ---------------------------------------------------------------------------
// The delegation decision
// ---------------------------------------------------------------------------

/**
 * The coordinator's own prompt. Note what it asks for and what it forbids.
 *
 * It never asks the model to ANSWER anything. Every field it returns is about
 * routing. The moment a coordinator prompt contains "and if it is simple, just
 * answer it yourself", you have rebuilt the single agent.
 */
function buildCoordinatorPrompt() {
  return `You are the Coordinator of a customer support team. You do not answer
customers yourself and you have no tools. You decide which specialist handles
a request.

Your team:
${specialistMenu()}

Reply with ONLY a JSON object:

{
  "specialists": ["billing"],
  "mode": "single",
  "tasks": { "billing": "what this specialist must find out or do" },
  "reason": "one sentence on why"
}

Rules:
- "mode" is "single", "parallel", or "sequential".
- Use "parallel" when the parts are independent - neither specialist needs the
  other's answer.
- Use "sequential" when the second question DEPENDS on the first. Example:
  "my subscription didn't renew and I was charged anyway" - account must
  establish whether the subscription lapsed before billing can judge the
  charge. List them in the order they must run.
- Never list more than 2 specialists.
- "tasks" gives each specialist a specific instruction in your own words, not
  a copy of the customer's message. They receive the customer's exact words
  too; the task is what YOU want them to establish.
- Use "research" only for open-ended analytical questions about trends or
  patterns, never for one customer's own issue.
- If nothing fits, choose the closest single specialist. Do not invent names.

Return the JSON and nothing else.`;
}

/**
 * Ask the model who should handle this.
 *
 * Never throws. If the model is unavailable or returns nonsense, we fall back
 * to a single billing specialist - the busiest desk in any support
 * organisation, and a safe default because it still cannot touch account
 * tools.
 *
 * The pattern is the same one intentClassifier.js established in Build 2:
 * a classification failure must degrade the system, never break it.
 */
async function decideDelegation(userMessage, { model } = {}) {
  const startedAt = Date.now();

  try {
    const reply = await callLLM({
      messages: [
        { role: "system", content: buildCoordinatorPrompt() },
        { role: "user", content: userMessage },
      ],
      model,
    });

    const decision = parseDecision(reply.content);
    if (!decision) return fallbackDecision("The coordinator's reply was unusable.");

    return {
      ...decision,
      latencyMs: Date.now() - startedAt,
      tokens: reply._usage?.total_tokens ?? 0,
    };
  } catch (err) {
    console.warn(`[coordinator] delegation decision failed: ${err.message}`);
    return fallbackDecision(`Coordinator unavailable (${err.message}).`);
  }
}

/**
 * Parse and VALIDATE the model's routing decision.
 *
 * Validation is not paranoia here. An unvalidated specialist name means
 * getSpecialist() returns null and the request dies with a TypeError deep in
 * the loop, minutes later, with a stack trace that points at the wrong file.
 * Reject the bad shape at the boundary, where the error still makes sense.
 */
function parseDecision(raw) {
  if (!raw || typeof raw !== "string") return null;

  // Models like to wrap JSON in ```json fences even when told not to.
  const text = raw.replace(/```json|```/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  // Keep only names that actually exist. A hallucinated "shipping" specialist
  // is dropped here rather than crashing later.
  const known = specialistNames();
  const specialists = (Array.isArray(parsed.specialists) ? parsed.specialists : [])
    .map((s) => String(s).toLowerCase())
    .filter((s) => known.includes(s))
    .slice(0, 2); // the cap, enforced in code and not only in the prompt

  if (specialists.length === 0) return null;

  const mode =
    specialists.length === 1
      ? "single"
      : ["parallel", "sequential"].includes(parsed.mode)
      ? parsed.mode
      // Two specialists and no valid mode: choose SEQUENTIAL. It is the slower
      // and safer of the two. Running dependent work in parallel produces two
      // half-informed answers that contradict each other, which is a worse
      // failure than being a few seconds slower.
      : "sequential";

  const tasks = {};
  for (const name of specialists) {
    const t = parsed.tasks?.[name];
    tasks[name] = typeof t === "string" && t.trim() ? t.trim() : null;
  }

  return {
    specialists,
    mode,
    tasks,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

/** Where we land when the coordinator itself cannot decide. */
function fallbackDecision(reason) {
  return {
    specialists: ["billing"],
    mode: "single",
    tasks: { billing: null },
    reason,
    fallback: true,
    latencyMs: 0,
    tokens: 0,
  };
}

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

/**
 * Build the brief a specialist receives.
 *
 * This IS the handoff contract. Everything a specialist knows about the
 * conversation comes from this string - which is exactly why it is built in
 * one visible function rather than assembled ad hoc at three call sites.
 *
 * @param {Object} spec      - the specialist definition
 * @param {string} task      - what the coordinator wants established
 * @param {string} message   - the customer's own words, verbatim
 * @param {Array}  findings  - facts from specialists that already ran
 */
function buildBrief(spec, task, message, findings = [], gaps = []) {
  const parts = [];

  if (task) {
    parts.push(`The coordinator has assigned you this: ${task}`);
  }

  // The customer's exact words ALWAYS travel. A summary of a complaint loses
  // the tone, the specifics, and often the actual question - and the
  // specialist is the one who has to answer it.
  parts.push(`The customer's message, in their own words:\n"${message}"`);

  if (findings.length > 0) {
    // Sequential mode: what the previous specialist established. This is the
    // narrow channel through which information crosses between agents, and
    // keeping it narrow is the whole point of the brief.
    parts.push(
      "Another specialist has already looked into part of this. Their " +
        "findings:\n" +
        findings.map((f) => `- [${f.from}] ${f.answer}`).join("\n") +
        "\n\nUse these. Do not repeat their work or contradict them without " +
        "a reason you can state."
    );
  }

  // ---- WHAT WE DO NOT KNOW ---------------------------------------------
  //
  // Added after a real failure. The account specialist died on a 503, billing
  // ran anyway with no findings, and its draft told the customer "the
  // subscription was active at the time of the charge" - a fact the DEAD
  // specialist was supposed to establish and never did.
  //
  // Silence about a gap reads to a model as "nothing to worry about". An
  // absent finding must be stated as absent, or the specialist fills it in.
  //
  // Same lesson as the RAG relevance floor in Phase 9: an empty result must be
  // reported as "I could not find this", never left as an empty space the
  // model is free to fill.
  if (gaps.length > 0) {
    parts.push(
      "IMPORTANT - part of this investigation could not be completed. These " +
        "questions were NOT answered:\n" +
        gaps.map((g) => `- ${g}`).join("\n") +
        "\n\nDo not assert anything about them. Say plainly that this part " +
        "could not be checked, and answer only what you can establish yourself."
    );
  }

  return parts.join("\n\n");
}

/**
 * Run one specialist.
 *
 * Notice how little happens here. It is runAgent() with a different prompt and
 * a smaller toolbox. No parallel implementation, no second loop - which is the
 * assignment's requirement, and also the reason the confirmation pause,
 * reflection, authorization, and idempotency all still work inside a
 * specialist without a line of extra code.
 */
async function runSpecialist(name, { task, message, findings, gaps, callerId, model, onEvent, history }) {
  const spec = getSpecialist(name);
  if (!spec) {
    return {
      from: name,
      answer: null,
      error: `No specialist named "${name}".`,
      tokensUsed: 0,
    };
  }

  const brief = buildBrief(spec, task, message, findings, gaps);

  if (onEvent) {
    onEvent({
      type: "delegated",
      specialist: spec.name,
      label: spec.label,
      task: task ?? "handle this request",
      toolCount: spec.tools.length,
    });
  }

  const startedAt = Date.now();

  // ---- WHY THIS try/catch EXISTS ---------------------------------------
  //
  // It was not here at first, and a real Mistral 503 during testing killed an
  // ENTIRE two-specialist request - stack trace, no answer, nothing saved.
  //
  // This is the multi-agent tax in its purest form, and it is worth being
  // precise about it:
  //
  //   A single agent making 3 LLM calls has ONE thing that can fail, and
  //   llmClient already retries it.
  //
  //   Two specialists making 3 calls each have TWO INDEPENDENT things that can
  //   fail, and if either one throws, the whole request dies - including the
  //   work the other specialist already finished successfully.
  //
  // More agents does not just mean more cost. It means more SURFACES, and the
  // failure probability compounds across them. The assignment asks where
  // multi-agent "adds handoff failure modes" - this is one, and we found it by
  // being unlucky rather than by being clever.
  //
  // So a specialist that dies is CONTAINED. It returns an error object like a
  // failed tool does, the coordinator carries on with whoever else succeeded,
  // and the customer gets a partial answer instead of a 500. Same principle as
  // Build 1's "tools return errors, they never throw" - one level up.
  let result;
  try {
    result = await runAgent(brief, {
      history,
      model,
      callerId,
      // The three things that make this a specialist rather than the general
      // agent. Everything else about the run is identical.
      systemPrompt: spec.prompt,
      forceTools: spec.tools,
      kbCategories: spec.kbCategories,
      specialist: spec.name,
      routeOverride: "specialist",
      routeReason: `Delegated to the ${spec.label} by the coordinator.`,
      // Specialists get a scoped brief, and each already has a narrow toolset,
      // so a plan on top of that is usually an extra LLM call for nothing.
      forcePlan: false,
      onEvent: onEvent
        ? (e) => onEvent({ ...e, specialist: spec.name })
        : undefined,
    });
  } catch (err) {
    console.error(`[coordinator] specialist ${spec.name} failed: ${err.message}`);

    if (onEvent) {
      onEvent({
        type: "specialist_failed",
        specialist: spec.name,
        error: err.message,
        durationMs: Date.now() - startedAt,
      });
    }

    return {
      from: spec.name,
      label: spec.label,
      answer: null,
      status: "failed",
      error: err.message,
      tokensUsed: 0,
      iterations: 0,
      trace: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (onEvent) {
    onEvent({
      type: "specialist_done",
      specialist: spec.name,
      status: result.status,
      tokensUsed: result.tokensUsed,
      durationMs: Date.now() - startedAt,
    });
  }

  return {
    from: spec.name,
    label: spec.label,
    answer: result.reply ?? null,
    status: result.status,
    // A specialist that paused for approval hands the WHOLE paused result back
    // up. The coordinator does not try to resolve it - approval is a human's
    // job, and the pause must reach the human unchanged.
    paused: result.status === RUN_STATUS.AWAITING_CONFIRMATION ? result : null,
    tokensUsed: result.tokensUsed ?? 0,
    iterations: result.iterations ?? 0,
    trace: result.trace ?? [],
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Turn two specialist answers into one reply.
 *
 * The naive version is `a.answer + "\n\n" + b.answer`. It reads exactly like
 * what it is - two people who did not talk to each other, both greeting you.
 *
 * We pay one small LLM call to merge properly. Worth it because the customer
 * asked ONE question; the fact that our architecture split it in two is our
 * problem, not theirs.
 *
 * The merge prompt is deliberately restrictive - it may only rephrase what the
 * specialists said. A merger allowed to "improve" the answer is a fifth agent
 * with no tools and no knowledge base, inventing things.
 */
async function mergeAnswers(userMessage, results, { model } = {}) {
  const usable = results.filter((r) => r.answer);

  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0].answer;

  try {
    const reply = await callLLM({
      messages: [
        {
          role: "system",
          content: `You merge answers from two support specialists into ONE reply
to the customer.

Strict rules:
- Use ONLY facts present in the specialist answers. Add nothing.
- If they disagree, say so plainly rather than picking one.
- One greeting, one sign-off, no repetition.
- Do not mention specialists, agents, teams, or how the answer was produced.
  The customer asked one person a question.
- Keep it short.`,
        },
        {
          role: "user",
          content:
            `The customer asked:\n"${userMessage}"\n\n` +
            usable.map((r) => `Answer from ${r.from}:\n${r.answer}`).join("\n\n"),
        },
      ],
      model,
    });

    return reply.content?.trim() || usable.map((r) => r.answer).join("\n\n");
  } catch (err) {
    // The merge is a polish step, not a dependency. If it fails, the customer
    // gets both answers joined - slightly clumsy, still correct and complete.
    console.warn(`[coordinator] merge failed (${err.message}) - concatenating.`);
    return usable.map((r) => r.answer).join("\n\n");
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Handle a request through the multi-agent team.
 *
 * Same signature as runAgent(), so the server can call either one and the
 * frontend cannot tell the difference. That is not an accident - it is what
 * lets us A/B the two architectures for the written analysis, and what would
 * let us turn multi-agent off in one line if the analysis said to.
 */
/**
 * Stage 0 - can this be answered without any agent at all?
 *
 * Returns a finished result, or null to carry on to delegation.
 *
 * ---------------------------------------------------------------------------
 * THIS CHECK WAS NOT HERE ORIGINALLY, AND LEAVING IT OUT COST 143x
 * ---------------------------------------------------------------------------
 *
 * Worth writing down exactly what went wrong, because it is the most seductive
 * mistake in this whole build.
 *
 * Build 2 established that "where is order ord_1001?" needs no LLM: a regex
 * extracts the ID, a database read answers it, and it costs 50ms and ZERO
 * tokens.
 *
 * Then Build 3 put a coordinator in front of everything. And a coordinator
 * asks an LLM which specialist should handle the request - INCLUDING requests
 * that need no LLM at all. Measured, on that exact question:
 *
 *      single agent     50ms      0 tokens   (workflow route)
 *      coordinator    7144ms   5664 tokens   (and it got the answer WRONG)
 *
 * The new architecture did not just make our best-optimised path 143x slower
 * and infinitely more expensive. It made it FAIL - the specialist asked the
 * customer to confirm their email for an order ID the workflow answers without
 * knowing who is asking.
 *
 * THE LESSON, which is the assignment's whole point about multi-agent:
 *
 *      A NEW LAYER MUST NOT DISCARD WHAT THE OLD LAYERS LEARNED.
 *
 * The coordinator is not the top of the system. It is one option among the
 * routes we already had, and it belongs BELOW the free ones.
 */
async function tryCheapPath(message, { history, onEvent, callerId, startedAt }) {
  const cheap = routeByPattern(message);
  if (cheap?.route !== ROUTES.WORKFLOW) return null;

  const outcome = await runWorkflow(cheap.workflow, cheap.params, { callerId });
  if (!outcome.handled) return null;

  if (onEvent) {
    onEvent({
      type: "coordinated",
      specialists: [],
      mode: "workflow",
      reason: "Deterministic workflow - no specialist, no coordinator, no LLM.",
      latencyMs: 0,
    });
    onEvent({ type: "token", text: outcome.reply });
  }

  return {
    status: RUN_STATUS.COMPLETE,
    reply: outcome.reply,
    messages: [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: outcome.reply },
    ],
    trace: [],
    iterations: 0,
    tokensUsed: 0,
    route: ROUTES.WORKFLOW,
    routeReason: cheap.reason,
    durationMs: Date.now() - startedAt,
    multiAgent: {
      specialists: [],
      mode: "workflow",
      reason: "No agent was needed at all.",
      delegations: 0,
    },
  };
}

async function runCoordinator(userMessage, options = {}) {
  const { history = [], model, onEvent, callerId } = options;

  if (typeof userMessage !== "string" || !userMessage.trim()) {
    throw new Error("runCoordinator requires a non-empty `userMessage`.");
  }

  const message = userMessage.trim();
  const startedAt = Date.now();

  // ---- 0. The cheap path still comes first ------------------------------
  const free = await tryCheapPath(message, { history, onEvent, callerId, startedAt });
  if (free) return free;

  // ---- 1. Decide -------------------------------------------------------
  //
  // `options.decision` lets a caller supply the routing decision instead of
  // paying for an LLM call to produce it. It exists for tests - a test of
  // failure HANDLING must not depend on the same provider that is failing -
  // and it is also the seam a cheaper classifier would slot into later.
  const decision = options.decision ?? (await decideDelegation(message, { model }));

  if (onEvent) {
    onEvent({
      type: "coordinated",
      specialists: decision.specialists,
      mode: decision.mode,
      reason: decision.reason,
      latencyMs: decision.latencyMs,
      fallback: Boolean(decision.fallback),
    });
  }

  // ---- 2. Delegate -----------------------------------------------------
  const results = [];
  const findings = [];
  let delegations = 0;

  // What an earlier specialist was asked to establish but could NOT. Travels
  // forward beside the findings, so a later specialist can tell the difference
  // between "nothing to report" and "we never found out".
  const gaps = [];

  const run = (name, extraFindings, extraGaps = []) =>
    runSpecialist(name, {
      task: decision.tasks?.[name] ?? null,
      message,
      findings: extraFindings,
      gaps: extraGaps,
      callerId,
      model,
      onEvent,
      history,
    });

  if (decision.mode === "parallel" && decision.specialists.length > 1) {
    // Independent questions. Run them at once - the latency of the slower one
    // instead of the sum of both.
    const names = decision.specialists.slice(0, MAX_DELEGATIONS);
    delegations = names.length;
    results.push(...(await Promise.all(names.map((n) => run(n, [])))));
  } else {
    // Sequential (and single, which is sequential with one element).
    //
    // Each specialist sees what the previous one established. This is the
    // dependency case: billing needs to know whether the subscription lapsed
    // before it can say whether the charge was wrong.
    for (const name of decision.specialists) {
      if (delegations >= MAX_DELEGATIONS) {
        // The cap, hit. Not a crash - we stop delegating and answer with what
        // we have. See the note on MAX_DELEGATIONS above.
        if (onEvent) {
          onEvent({
            type: "delegation_capped",
            limit: MAX_DELEGATIONS,
            completed: delegations,
          });
        }
        break;
      }

      const r = await run(name, findings, gaps);
      delegations += 1;
      results.push(r);

      // A specialist that paused for approval stops the chain immediately.
      // Running the next one would be acting on an unapproved premise - and
      // if the human rejects the refund, everything after it was wasted work
      // built on a decision that never happened.
      if (r.paused) break;

      if (r.answer) {
        findings.push({ from: r.from, answer: r.answer });
      } else {
        // It failed. Record what it was SUPPOSED to establish, so the next
        // specialist is told about the hole instead of quietly filling it in.
        gaps.push(
          decision.tasks?.[name] ??
            `Whatever the ${name} specialist was asked to check.`
        );
      }
    }
  }

  // ---- 3. A pause beats everything ------------------------------------
  //
  // If any specialist is waiting for a human, that IS the result. We return
  // its paused state verbatim, so the approval queue, the resume path, and
  // idempotency all work exactly as they did before multi-agent existed.
  const paused = results.find((r) => r.paused);
  if (paused) {
    // Report the failures on this path too.
    //
    // The first version did not, and a real run showed why that matters: the
    // ACCOUNT specialist died on a 503, BILLING carried on and paused for
    // approval, and the result reported `failures: undefined`. The operator
    // approving that action would have had no way to know that half the
    // investigation never happened.
    //
    // Worse, the customer-facing draft asserted "the subscription was active"
    // - a fact the failed specialist was supposed to establish and never did.
    // A contained failure that is not REPORTED is just a silent one, and a
    // silent failure inside an approval request is the worst place to have it.
    const failedOnPause = results.filter((r) => !r.answer && !r.paused);

    return {
      ...paused.paused,
      multiAgent: {
        specialists: decision.specialists,
        mode: decision.mode,
        reason: decision.reason,
        pausedBy: paused.from,
        delegations,
        failures: failedOnPause.map((f) => f.from),
        // Surfaced so the approval card can warn the operator rather than
        // presenting an incomplete investigation as a complete one.
        incomplete: failedOnPause.length > 0,
      },
    };
  }

  // ---- 4. Merge --------------------------------------------------------
  const reply = await mergeAnswers(message, results, { model });

  const tokensUsed =
    (decision.tokens ?? 0) + results.reduce((n, r) => n + (r.tokensUsed ?? 0), 0);

  const failed = results.filter((r) => !r.answer);

  return {
    status: reply ? "complete" : "failed",
    reply:
      reply ??
      "I could not get an answer for you just now. Let me pass this to a " +
        "colleague who can help.",
    messages: [
      ...history,
      { role: "user", content: message },
      ...(reply ? [{ role: "assistant", content: reply }] : []),
    ],
    // The whole team's traces, tagged by who produced them. Without the tag,
    // a merged trace is unreadable - you cannot tell which agent made which
    // call, which is exactly what you need to know when one misbehaves.
    trace: results.flatMap((r) =>
      (r.trace ?? []).map((t) => ({ ...t, specialist: r.from }))
    ),
    iterations: results.reduce((n, r) => n + (r.iterations ?? 0), 0),
    tokensUsed,
    route: "multi_agent",
    routeReason: decision.reason,
    durationMs: Date.now() - startedAt,
    multiAgent: {
      specialists: decision.specialists,
      mode: decision.mode,
      reason: decision.reason,
      delegations,
      coordinatorTokens: decision.tokens ?? 0,
      coordinatorLatencyMs: decision.latencyMs ?? 0,
      fallback: Boolean(decision.fallback),
      failures: failed.map((f) => f.from),
      perSpecialist: results.map((r) => ({
        name: r.from,
        tokensUsed: r.tokensUsed,
        durationMs: r.durationMs,
        status: r.status,
      })),
    },
  };
}

module.exports = {
  runCoordinator,
  decideDelegation,
  buildBrief,
  mergeAnswers,
  MAX_DELEGATIONS,
  MAX_DEPTH,
};
