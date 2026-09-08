/**
 * server.js
 *
 * The front door. Receives HTTP requests, hands them to the agent, sends the
 * answer back.
 *
 * This file deliberately contains no agent logic. Its only jobs are to validate
 * what arrived over the wire, call `runAgent`, and translate the result into an
 * HTTP response. Keeping transport separate from reasoning means the same agent
 * core can later be driven by SSE, a queue worker, or the voice pipeline in
 * Build 3 without being rewritten.
 */

require("dotenv").config();

const express = require("express");
const { runAgent, resumeAgent } = require("./agent/agentRunner");
const { runCoordinator } = require("./agents/coordinator");
const { runResearch, getReport, listReports } = require("./research/researchAgent");

/**
 * Which architecture handles this request: the single agent, or the
 * multi-agent team?
 *
 * A SWITCH ON THE EXISTING ENDPOINT, not a second endpoint. Two reasons:
 *
 *   1. The written analysis needs the two architectures to be directly
 *      comparable. Same route, same validation, same rate limiting, same
 *      response shape - so the only variable is the architecture itself.
 *      A separate /chat/multi would differ in a dozen incidental ways.
 *
 *   2. runCoordinator() has the same signature and returns the same shape as
 *      runAgent(). That is not an accident - it is what makes this one line
 *      instead of a branch through the whole file, and what would let us turn
 *      multi-agent off in production by flipping a default.
 *
 * Default is the single agent, because the numbers say it wins for most
 * traffic. Opt in per request with `"multiAgent": true`, or globally with
 * MULTI_AGENT=true in .env.
 */
function agentFor(body) {
  const wants =
    body?.multiAgent ?? (process.env.MULTI_AGENT === "true");
  return wants ? runCoordinator : runAgent;
}
const { connectDB, disconnectDB, isConnected } = require("./db/connection");
const { loadRun, listRuns } = require("./db/persistence");
const { AgentRun } = require("./db/models");
const { connectVectorStore, isAvailable: kbAvailable, count: kbCount } = require("./rag/vectorStore");
const { connectRedis, disconnectRedis, isReady: redisReady } = require("./cache/redis");
const { checkRateLimit, recordTokens, getUsage } = require("./cache/rateLimit");
const {
  listPending,
  getPending,
  claimRun,
  releaseRun,
  APPROVAL_TTL_MS,
} = require("./agent/approvals");

const app = express();

// Reject absurdly large bodies. Without a limit, a single request can pin the
// process while Express buffers megabytes of JSON we were never going to use.
app.use(express.json({ limit: "100kb" }));

/**
 * GET /health
 *
 * Liveness check. Deliberately does no work and touches no dependencies, so it
 * stays fast and cannot fail for reasons unrelated to the process being up.
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "helpdesk-copilot-backend",
    // Reported, not enforced: the server is healthy either way, because the
    // agent's safety rails do not depend on the database. This tells an
    // operator whether traces are being recorded.
    database: isConnected() ? "connected" : "unavailable",
    knowledgeBase: kbAvailable() ? "connected" : "unavailable",
    rateLimiting: redisReady() ? "enforced" : "off (redis unavailable)",
  });
});

/**
 * GET /runs        - recent agent runs
 * GET /runs/:runId - one run in full, with its trace
 *
 * The assignment requires "every iteration persisted - the full trace must be
 * inspectable afterwards" and a "trace viewer". This is the data behind it.
 */
/**
 * GET /usage - what this caller has spent in the current windows.
 * Lets a client show its own budget instead of discovering it via a 429.
 */
/**
 * THE OPERATOR APPROVAL QUEUE
 *
 * The assignment: "pending approvals showing the request, the agent's
 * reasoning, the exact action proposed, and the customer context - with
 * Approve / Reject / Modify".
 *
 * Note what these endpoints do NOT need: the client no longer carries the
 * paused state. In Build 1 the browser held it and posted it back, which meant
 * closing the tab lost the approval. Now the state lives in MongoDB and an
 * operator resumes a run by ID alone - from any machine, hours later, on a
 * server process that has never seen the original request.
 */

/** GET /approvals - everything waiting for a human. */
app.get("/approvals", async (req, res) => {
  if (!isConnected()) {
    return res.status(503).json({
      error: "persistence_unavailable",
      message:
        "The approval queue requires MongoDB. Paused runs cannot be listed " +
        "while it is unreachable.",
    });
  }
  res.json({
    approvals: await listPending({ limit: Math.min(Number(req.query.limit) || 50, 200) }),
    ttlHours: APPROVAL_TTL_MS / 3600000,
  });
});

/** GET /approvals/:runId - one pending run in full. */
app.get("/approvals/:runId", async (req, res) => {
  const run = await getPending(req.params.runId);
  if (!run) {
    return res.status(404).json({
      error: "not_pending",
      message: `Run ${req.params.runId} is not awaiting approval. It may have been resolved already.`,
    });
  }
  res.json(run);
});

/**
 * POST /approvals/:runId - approve, reject, or modify.
 *
 * Body: { "approved": true|false, "modifiedArguments": {...}, "rejectionNote": "..." }
 *
 * IDEMPOTENCY: claimRun() atomically flips the status from
 * awaiting_confirmation to resuming. A second click finds nothing to claim and
 * gets 409 instead of issuing a second refund.
 */
app.post("/approvals/:runId", async (req, res) => {
  const { approved, modifiedArguments, rejectionNote } = req.body ?? {};

  if (typeof approved !== "boolean") {
    return res.status(400).json({
      error: "invalid_request",
      message: "`approved` must be true or false.",
    });
  }
  if (
    modifiedArguments !== undefined &&
    (typeof modifiedArguments !== "object" ||
      modifiedArguments === null ||
      Array.isArray(modifiedArguments))
  ) {
    return res.status(400).json({
      error: "invalid_request",
      message: "`modifiedArguments`, if provided, must be an object.",
    });
  }

  // The claim. Exactly one caller can win this.
  const claimed = await claimRun(req.params.runId);
  if (!claimed) {
    return res.status(409).json({
      error: "already_resolved",
      message:
        "This approval has already been actioned, or is being actioned right " +
        "now. It was not applied twice.",
    });
  }

  try {
    // Rebuild the paused state from the stored document. This is the moment
    // that proves the Step 6 design: everything resumeAgent needs is data, so
    // a server that has never seen this run can finish it.
    const state = {
      status: "awaiting_confirmation",
      pending: claimed.pending,
      messages: claimed.messages,
      trace: claimed.trace,
      iterations: claimed.iterations,
      tokensUsed: claimed.tokensUsed,
      runId: claimed.runId,
      conversationId: claimed.conversationId,
      userMessage: claimed.userMessage,
      startedAt: claimed.startedAt ? new Date(claimed.startedAt).getTime() : Date.now(),
      // The authorization badge, restored. Without this the confirmed write
      // would execute as an anonymous caller.
      callerId: claimed.callerId,
    };

    const result = await resumeAgent(state, approved, {
      modifiedArguments,
      rejectionNote,
    });

    recordTokens(claimed.callerId, result.tokensUsed - (claimed.tokensUsed ?? 0));

    res.json(formatAgentResult(result));
  } catch (err) {
    // Un-claim, or the run is stranded in "resuming" forever - invisible to the
    // queue and impossible to approve.
    await releaseRun(req.params.runId);
    console.error("[/approvals] resume failed:", err);
    res.status(502).json({
      error: "agent_error",
      message: "The agent could not resume this run. It has been returned to the queue.",
    });
  }
});

/**
 * GET /routing - how traffic actually split across the three paths.
 *
 * The assignment: "Track the distribution - what percentage of traffic
 * actually needs an autonomous agent? That number is the argument for this
 * whole design, and it's usually surprisingly low."
 *
 * It also names the failure mode: "If every request routes to the autonomous
 * agent, the routing layer isn't doing its job." So this endpoint is not
 * decoration - it is how you check the router is earning its place.
 */
app.get("/routing", async (req, res) => {
  if (!isConnected()) {
    return res.status(503).json({
      error: "persistence_unavailable",
      message: "Routing analytics need MongoDB.",
    });
  }

  const rows = await AgentRun.aggregate([
    { $match: { route: { $ne: null } } },
    {
      $group: {
        _id: "$route",
        count: { $sum: 1 },
        avgTokens: { $avg: "$tokensUsed" },
        avgIterations: { $avg: "$iterations" },
        avgDurationMs: { $avg: "$durationMs" },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;

  res.json({
    total,
    routes: rows.map((r) => ({
      route: r._id,
      count: r.count,
      percentage: Number(((r.count / total) * 100).toFixed(1)),
      avgTokens: Math.round(r.avgTokens ?? 0),
      avgIterations: Number((r.avgIterations ?? 0).toFixed(1)),
      avgDurationMs: Math.round(r.avgDurationMs ?? 0),
    })),
  });
});

/**
 * GET /costs
 *
 * Per-agent cost tracking. The assignment marks this separately from routing:
 *
 *   "Cost tracking dashboard: latency, tokens, and tool calls per agent -
 *    multi-agent multiplies LLM calls; the numbers you see here are your
 *    evidence for the written analysis."
 *
 * WHY THIS IS NOT THE SAME AS /routing:
 *
 *   /routing groups by ROUTE and answers "what fraction of traffic needs an
 *   agent at all?" - the Build 2 question.
 *
 *   /costs groups by AGENT and answers "what does each specialist cost us?" -
 *   the Build 3 question. It is the difference between knowing that
 *   specialists are expensive and knowing WHICH one, which is the number that
 *   actually changes a decision.
 *
 * Tool calls are counted from the trace rather than stored as a number,
 * because a stored counter can drift from the trace it claims to summarise.
 * Deriving it means the two can never disagree.
 */
// ---------------------------------------------------------------------------
// RESEARCH
// ---------------------------------------------------------------------------
//
// The research agent is long-running by nature - it decomposes a question,
// fans out across several sources, and synthesises. So it gets THREE
// endpoints rather than one, and the split is the point:
//
//   POST /research        start one, stream progress over SSE
//   GET  /research        list past reports
//   GET  /research/:id    re-open a finished one
//
// The assignment: "Long-running: streams progress ... and must survive being
// closed and reopened." A single request/response endpoint cannot satisfy the
// second half - close the tab and the work is gone. Because a report row is
// written when the investigation STARTS, the GET endpoints can answer even
// while it is still running.
app.post("/research", async (req, res) => {
  const { question } = req.body ?? {};

  if (typeof question !== "string" || question.trim().length < 8) {
    return res.status(400).json({
      error: "invalid_question",
      message: "Provide a `question` of at least 8 characters.",
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  const send = (event) => {
    if (clientGone) return;
    const { type, ...data } = event;
    res.write(`event: ${type}
`);
    res.write(`data: ${JSON.stringify(data)}

`);
  };

  try {
    const report = await runResearch(question.trim(), {
      callerId: callerFrom(req),
      onEvent: send,
    });
    send({ type: "report", ...report });
  } catch (err) {
    console.error("[/research] failed:", err);
    send({ type: "error", message: "The investigation could not be completed." });
  } finally {
    res.end();
  }
});

app.get("/research", async (req, res) => {
  res.json({ reports: await listReports(Number(req.query.limit) || 20) });
});

app.get("/research/:reportId", async (req, res) => {
  const report = await getReport(req.params.reportId);
  if (!report) {
    return res.status(404).json({
      error: "not_found",
      message: `No research report with id ${req.params.reportId}.`,
    });
  }
  res.json(report);
});

app.get("/costs", async (req, res) => {
  if (!isConnected()) {
    return res.status(503).json({
      error: "persistence_unavailable",
      message: "Cost analytics need MongoDB.",
    });
  }

  const rows = await AgentRun.aggregate([
    {
      $group: {
        // A run with no specialist is the single agent. Labelling it
        // explicitly means the dashboard compares like with like instead of
        // showing a mysterious "null" row.
        _id: { $ifNull: ["$specialist", "single-agent"] },
        runs: { $sum: 1 },
        totalTokens: { $sum: "$tokensUsed" },
        avgTokens: { $avg: "$tokensUsed" },
        avgDurationMs: { $avg: "$durationMs" },
        avgIterations: { $avg: "$iterations" },
        toolCalls: {
          $sum: {
            $reduce: {
              input: { $ifNull: ["$trace", []] },
              initialValue: 0,
              in: {
                $add: [
                  "$$value",
                  { $size: { $ifNull: ["$$this.toolCalls", []] } },
                ],
              },
            },
          },
        },
        pauses: {
          $sum: { $cond: [{ $eq: ["$status", "awaiting_confirmation"] }, 1, 0] },
        },
      },
    },
    { $sort: { totalTokens: -1 } },
  ]);

  const totalTokens = rows.reduce((n, r) => n + (r.totalTokens ?? 0), 0) || 1;

  res.json({
    agents: rows.map((r) => ({
      agent: r._id,
      runs: r.runs,
      totalTokens: r.totalTokens ?? 0,
      shareOfSpend: Number((((r.totalTokens ?? 0) / totalTokens) * 100).toFixed(1)),
      avgTokens: Math.round(r.avgTokens ?? 0),
      avgDurationMs: Math.round(r.avgDurationMs ?? 0),
      avgIterations: Number((r.avgIterations ?? 0).toFixed(1)),
      toolCalls: r.toolCalls ?? 0,
      avgToolCalls: Number(((r.toolCalls ?? 0) / (r.runs || 1)).toFixed(1)),
      pauses: r.pauses ?? 0,
    })),
    totalTokens,
    totalRuns: rows.reduce((n, r) => n + r.runs, 0),
  });
});

app.get("/usage", async (req, res) => {
  res.json(await getUsage(callerFrom(req)));
});

app.get("/runs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json({ runs: await listRuns(limit) });
});

app.get("/runs/:runId", async (req, res) => {
  const run = await loadRun(req.params.runId);
  if (!run) {
    return res.status(404).json({
      error: "run_not_found",
      message: `No run with ID ${req.params.runId}. It may have expired, or persistence may be unavailable.`,
    });
  }
  res.json(run);
});

/**
 * POST /chat
 *
 * Body: { "message": "...", "history": [ ...optional prior messages ] }
 *
 * Returns: { "reply": "...", "history": [...], "iterations": n }
 *
 * The client owns conversation state and passes `history` back on each turn.
 * That keeps the server stateless, which means restarting it does not drop
 * anyone's conversation. Server-side persistence arrives with MongoDB later.
 */
/**
 * Who is making this request?
 *
 * TODAY: an x-caller-id header, which anyone could forge. That is honest about
 * what this is - AUTHORIZATION (what may this caller reach?) without
 * AUTHENTICATION (is this caller who they claim?).
 *
 * It still closes the hole we actually hit: an agent guessing an identity and
 * being believed. The model can guess all it likes; the guard in each tool
 * compares record ownership and does not read the conversation.
 *
 * LATER: a verified session replaces the header. Nothing downstream changes -
 * the guards already stand, they simply start reading a badge that cannot be
 * forged.
 */
/**
 * Clean conversation history arriving from a client.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The server is stateless: it returns `history`, the browser holds it, and
 * sends it back on the next turn. That is what lets the backend restart
 * mid-conversation without losing anything.
 *
 * But it also means **the conversation is client-supplied data**, and we were
 * forwarding it to the provider untouched. Two consequences, one cosmetic and
 * one not:
 *
 *   1. THE BUG. llmClient attaches `_usage` and `_provider` as our own
 *      metadata. runLoop strips them before pushing to `messages` - but the
 *      copy that went out in the HTTP response still carried them. The browser
 *      stored that copy and sent it back, and Mistral rejected the whole
 *      request:
 *
 *          422 extra_forbidden  body.messages[2].assistant._provider
 *
 *      A conversation would work for one or two turns and then break
 *      permanently, which reads exactly like a flaky backend.
 *
 *   2. THE TRUST PROBLEM. Anything a client sends here reaches the model. A
 *      forged history could claim a refund was already approved, or carry a
 *      role the provider does not accept. Keeping only known fields and known
 *      roles is cheap; discovering you needed it is not.
 *
 * So: allow-list, not deny-list. Keep the fields the API defines and drop
 * everything else, rather than naming the fields we happen to know are bad -
 * that list is always one release out of date.
 */
const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);
const ALLOWED_KEYS = ["role", "content", "tool_calls", "tool_call_id", "name"];

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((m) => m && typeof m === "object" && ALLOWED_ROLES.has(m.role))
    .map((m) => {
      const clean = {};
      for (const k of ALLOWED_KEYS) {
        if (m[k] !== undefined) clean[k] = m[k];
      }
      return clean;
    })
    // A cap, because history arrives from the client and an unbounded array is
    // an unbounded bill. The newest turns are the ones that matter.
    .slice(-40);
}

function callerFrom(req) {
  const id = req.get("x-caller-id");
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/**
 * Rate-limit gate shared by /chat and /chat/stream.
 *
 * Returns true if the request was rejected (and the response already sent), so
 * the caller reads as: `if (await rateLimited(req, res)) return;`
 *
 * 429 is the correct status - "too many requests" - and `Retry-After` tells a
 * well-behaved client exactly how long to wait rather than making it guess and
 * hammer.
 */
async function rateLimited(req, res) {
  const verdict = await checkRateLimit(callerFrom(req));
  if (verdict.allowed) return false;

  res.set("Retry-After", String(verdict.retryAfter));
  res.status(429).json({
    error: verdict.reason,
    message:
      verdict.reason === "too_many_requests"
        ? `Too many requests. You may make ${verdict.limit} per minute. Try again in ${verdict.retryAfter}s.`
        : `You have used your token budget for this hour (${verdict.limit.toLocaleString()}). It resets in ${Math.ceil(verdict.retryAfter / 60)} minutes.`,
    retryAfter: verdict.retryAfter,
  });
  return true;
}

app.post("/chat", async (req, res) => {
  const { message } = req.body ?? {};
  const history = sanitizeHistory(req.body?.history);

  // Validate at the boundary. Anything past this point can assume its inputs
  // are the right shape, which is what keeps the code underneath readable.
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({
      error: "invalid_request",
      message: "Body must include a non-empty `message` string.",
    });
  }

  if (history !== undefined && !Array.isArray(history)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "`history`, if provided, must be an array of messages.",
    });
  }

  if (await rateLimited(req, res)) return;

  const callerId = callerFrom(req);

  try {
    const result = await agentFor(req.body)(message, { history, callerId });

    // Charge what the request actually cost. Fire-and-forget: accounting must
    // never fail the customer's request.
    recordTokens(callerId, result.tokensUsed);

    res.json(formatAgentResult(result));
  } catch (err) {
    // Log the real error for us, return a generic one to the caller. Error
    // text from an upstream API can contain internal details, and echoing it
    // verbatim to clients leaks information about our infrastructure.
    console.error("[/chat] agent run failed:", err);

    res.status(502).json({
      error: "agent_error",
      message: "The agent could not complete this request. Please try again.",
    });
  }
});

/**
 * POST /chat/confirm
 *
 * Approve or reject an action the agent paused on.
 *
 * Body: {
 *   "state":    <the object /chat returned when it paused>,
 *   "approved": true | false,
 *   "modifiedArguments": {...},   optional - human edited the action
 *   "rejectionNote":     "..."    optional - why it was declined
 * }
 *
 * The client hands back the same `state` it received. The server kept no
 * memory of the paused run - which is the property that lets Build 2 store
 * that state in MongoDB and resume it after a restart, or on another machine.
 */
app.post("/chat/confirm", async (req, res) => {
  const { state, approved, modifiedArguments, rejectionNote } = req.body ?? {};

  if (!state || typeof state !== "object" || !state.pending) {
    return res.status(400).json({
      error: "invalid_request",
      message:
        "Body must include the `state` object returned by /chat when it " +
        "paused for confirmation.",
    });
  }

  if (typeof approved !== "boolean") {
    return res.status(400).json({
      error: "invalid_request",
      message: "`approved` must be true or false.",
    });
  }

  if (modifiedArguments !== undefined) {
    if (
      typeof modifiedArguments !== "object" ||
      modifiedArguments === null ||
      Array.isArray(modifiedArguments)
    ) {
      return res.status(400).json({
        error: "invalid_request",
        message: "`modifiedArguments`, if provided, must be an object.",
      });
    }
  }

  try {
    const result = await resumeAgent(state, approved, {
      modifiedArguments,
      rejectionNote,
    });

    // Charged, but NOT gated. A confirmation completes work the user already
    // started; refusing it would strand a paused refund, which is a worse
    // outcome than the marginal token cost.
    recordTokens(state.callerId, result.tokensUsed - (state.tokensUsed ?? 0));

    res.json(formatAgentResult(result));
  } catch (err) {
    console.error("[/chat/confirm] resume failed:", err);
    res.status(502).json({
      error: "agent_error",
      message: "The agent could not resume this request. Please try again.",
    });
  }
});

/**
 * Shape an agent result for the wire.
 *
 * Both /chat and /chat/confirm can finish OR pause, so they share this. When
 * paused we return the whole result as `state`, because that object is exactly
 * what resumeAgent needs back.
 */
/**
 * POST /chat/stream
 *
 * The same agent run as /chat, but the client watches it happen instead of
 * waiting in silence.
 *
 * WHAT SSE IS: Server-Sent Events. An ordinary HTTP response that we never
 * close, writing chunks of text as things happen. The browser's built-in
 * EventSource (or any fetch reader) receives each one as it arrives.
 *
 * The wire format is deliberately plain text:
 *
 *     event: tool_call\n
 *     data: {"tool":"getInvoices","args":{...}}\n
 *     \n                          <- blank line terminates the event
 *
 * Why SSE and not WebSockets? We only need server -> client. SSE is one-way,
 * runs over normal HTTP, reconnects on its own, and needs no extra library on
 * either side. WebSockets would be a bidirectional solution to a
 * unidirectional problem.
 */
app.post("/chat/stream", async (req, res) => {
  const { message } = req.body ?? {};
  const history = sanitizeHistory(req.body?.history);

  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({
      error: "invalid_request",
      message: "Body must include a non-empty `message` string.",
    });
  }
  if (history !== undefined && !Array.isArray(history)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "`history`, if provided, must be an array of messages.",
    });
  }

  if (await rateLimited(req, res)) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Without this, nginx and similar proxies buffer the whole response and
    // deliver it at the end - which defeats the entire point of streaming.
    "X-Accel-Buffering": "no",
  });

  // The client may close the tab mid-run. Track it so we stop writing to a
  // dead socket, and so the run's own events do not throw.
  //
  // LISTEN ON `res`, NOT `req`. This cost a debugging session:
  // `req.on("close")` fires as soon as the REQUEST stream finishes - which,
  // for a POST whose JSON body has already been read by express.json(), is
  // immediately. That set clientGone = true before a single event was sent,
  // and every write was silently skipped. The stream appeared to stall after
  // the first event with no error anywhere.
  //
  // `res.on("close")` is the one that means "the connection actually went
  // away".
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });

  const send = (event) => {
    if (clientGone) return;
    const { type, ...data } = event;
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const callerId = callerFrom(req);
    // Same switch as /chat. The coordinator emits its own event types
    // (coordinated, delegated, specialist_done, specialist_failed) through the
    // same onEvent channel, so the stream works for both architectures with no
    // special-casing here.
    const result = await agentFor(req.body)(message, {
      history,
      onEvent: send,
      callerId,
    });

    recordTokens(callerId, result.tokensUsed);

    // A final complete payload after the event stream, so a client that only
    // wants the answer does not have to reassemble it from token events.
    send({ type: "result", ...formatAgentResult(result) });
  } catch (err) {
    console.error("[/chat/stream] agent run failed:", err);
    send({
      type: "error",
      error: "agent_error",
      message: "The agent could not complete this request.",
    });
  } finally {
    if (!clientGone) res.end();
  }
});

function formatAgentResult(result) {
  const base = {
    status: result.status,
    reply: result.reply,
    history: result.messages,
    iterations: result.iterations,
    tokensUsed: result.tokensUsed,
    // The execution trace: what the agent decided each iteration, which tools
    // it called, with what arguments, and what came back. The frontend renders
    // this as the trace viewer.
    trace: result.trace,
    ...(result.stoppedReason && { stoppedReason: result.stoppedReason }),
    ...(result.route && { route: result.route }),
    // Present only when the multi-agent team handled it. The UI uses this to
    // show WHICH specialists were involved - and, importantly, whether any of
    // them failed, so an incomplete investigation is never presented as a
    // complete one.
    ...(result.multiAgent && { multiAgent: result.multiAgent }),
  };

  if (result.status === "awaiting_confirmation") {
    return {
      ...base,
      // What the UI shows in the confirmation modal - a readable sentence,
      // not raw arguments.
      confirmation: {
        action: result.pending.summary.action,
        detail: result.pending.summary.detail,
        reason: result.pending.summary.reason,
        irreversible: result.pending.summary.irreversible,
        warning: result.pending.summary.warning,
        tool: result.pending.name,
        arguments: result.pending.arguments,
      },
      // Opaque to the client: post it back to /chat/confirm unchanged.
      state: result,
    };
  }

  return base;
}

/**
 * Fallback for unmatched routes. Without this, Express returns an HTML error
 * page, which is confusing for a client that asked for JSON.
 */
app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: `No route for ${req.method} ${req.path}`,
  });
});

const PORT = process.env.PORT || 5000;

// Connect to MongoDB first, but do not block startup on it. connectDB()
// resolves false rather than throwing when the database is unreachable, so the
// server comes up either way - see src/db/connection.js for that reasoning.
connectDB();
connectVectorStore();
connectRedis();

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ---- VOICE ---------------------------------------------------------------
//
// The WebSocket endpoint shares this HTTP server rather than opening a second
// port: one certificate, one firewall rule, one origin. It also means voice is
// unreachable if the API is down, which is correct - they are one product.
//
// Note what is NOT being started here: no second agent, no voice-specific
// tools, no parallel loop. attachVoiceServer wraps runAgent(), the same
// function /chat calls.
const { attachVoiceServer } = require("./voice/voiceServer");
attachVoiceServer(server, { path: "/voice" });

// ---------------------------------------------------------------------------
// EXPIRE APPROVALS NOBODY ANSWERED
// ---------------------------------------------------------------------------
//
// `expireStale()` had existed since Build 2 - written, exported, documented,
// and never called by anything. So paused runs accumulated: 50 of them over
// five days, the oldest 120 hours old, and the Approvals tab wore a permanent
// red "50" badge.
//
// That badge is the actual damage. An operator who sees 50 items they know are
// junk stops reading the queue, and the one real approval underneath waits
// just as long as if there were no queue at all.
//
// The sweep runs once at boot (so a restart tidies up) and every 15 minutes
// after.
const { startExpirySweep } = require("./agent/approvals");
startExpirySweep();

/**
 * Shut down cleanly when the platform asks us to stop.
 *
 * Without this, the process dies instantly and any request mid-flight is cut
 * off. `server.close()` stops accepting new connections and lets in-flight
 * requests finish first.
 */
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(async () => {
      await disconnectDB();
      await disconnectRedis();
      process.exit(0);
    });
  });
}

module.exports = app;
