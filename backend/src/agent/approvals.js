/**
 * approvals.js
 *
 * The approval queue — durable human-in-the-loop.
 *
 * ---------------------------------------------------------------------------
 * WHAT BUILD 1 ALREADY GAVE US
 * ---------------------------------------------------------------------------
 *
 * The assignment calls this "the hardest engineering problem in Build 2: an
 * agent loop that survives suspension."
 *
 * Step 6 built the pause so it was RESUMABLE FROM DATA ALONE - no suspended
 * function, no closure, just a plain object. We proved it by killing the server
 * process between the pause and the approval and completing the run on a
 * different one.
 *
 * So the mechanism is done. What Build 2 adds is where that object LIVES:
 *
 *     Build 1:  the HTTP response  ->  client holds it  ->  posts it back
 *     Build 2:  MongoDB            ->  any server reads it  ->  resumes it
 *
 * Same loop, same resume function, different storage. That is the entire
 * change, and it is only that small because the shape was right first.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS BUILD 1 DID NOT HAVE
 * ---------------------------------------------------------------------------
 *
 * 1. IDEMPOTENCY. "Approving twice (double-click, retry) must not execute the
 *    action twice." In Build 1 the client held the state, so a double-click
 *    posted the same object twice and issued two refunds. Now that the state
 *    lives in one place, we can claim it - see approveRun().
 *
 * 2. A TIMEOUT POLICY. "What happens if no human responds in 24 hours? Design
 *    and defend it." See expireStale().
 */

const { AgentRun } = require("../db/models");
const { isConnected } = require("../db/connection");

/**
 * How long a pending approval waits before it is abandoned.
 *
 * DESIGN DECISION TO DEFEND: 24 hours, then EXPIRE - never auto-approve.
 *
 * The three options were:
 *
 *   auto-approve on timeout  ->  absolutely not. "Nobody looked at it" is the
 *                                weakest possible reason to move money. It also
 *                                creates an attack: submit a request at 5pm on
 *                                a Friday and wait.
 *   wait forever             ->  the queue silently fills with stale requests
 *                                and the customer never hears anything back.
 *   expire and tell someone  ->  chosen.
 *
 * Expiry is the same code path as a rejection, so the agent already knows how
 * to handle it: it does not crash, it explains to the customer, and it can
 * offer an alternative. A timeout is just a rejection nobody typed.
 */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * List runs waiting for a human.
 *
 * The assignment wants the operator queue to show "the request, the agent's
 * reasoning, the exact action proposed, and the customer context" - so this
 * returns all four rather than making the UI fetch each separately.
 */
async function listPending({ limit = 50 } = {}) {
  if (!isConnected()) return [];

  const runs = await AgentRun.find({ status: "awaiting_confirmation" })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return runs.map((run) => ({
    runId: run.runId,
    requestedAt: run.createdAt,
    ageMs: Date.now() - new Date(run.createdAt).getTime(),
    expired: Date.now() - new Date(run.createdAt).getTime() > APPROVAL_TTL_MS,

    // What the customer asked for
    customerMessage: run.userMessage,
    callerId: run.callerId ?? null,

    // What the agent proposes - the tool's own sentence, not raw arguments
    action: run.pending?.summary ?? null,
    tool: run.pending?.name ?? null,
    arguments: run.pending?.arguments ?? null,

    // WHY it proposes that. The operator needs the reasoning, not just the
    // verdict - approving an action you cannot explain is rubber-stamping.
    reasoning: (run.trace ?? [])
      .flatMap((t) => [
        ...(t.content ? [{ type: "thought", text: t.content }] : []),
        ...(t.toolCalls ?? []).map((c) => ({
          type: "tool",
          name: c.name,
          ok: c.ok,
          result: c.result,
        })),
      ]),

    iterations: run.iterations,
    tokensUsed: run.tokensUsed,
  }));
}

/** One pending run in full, for the detail view. */
async function getPending(runId) {
  if (!isConnected()) return null;
  return AgentRun.findOne({ runId, status: "awaiting_confirmation" }).lean();
}

/**
 * Claim a run for approval - ATOMICALLY.
 *
 * THIS IS THE IDEMPOTENCY GUARANTEE, and it is one line of query:
 *
 *     { runId, status: "awaiting_confirmation" }  ->  { status: "resuming" }
 *
 * `findOneAndUpdate` in MongoDB is atomic. Two simultaneous approvals both try
 * to match a document whose status is still "awaiting_confirmation"; exactly
 * one wins, and the loser gets null because the status already changed.
 *
 * The naive version is the same race we hit in the rate limiter:
 *
 *     const run = await find(runId);        // both find it pending
 *     if (run.status !== "pending") return; // both decide it is fine
 *     await resume(run);                    // BOTH REFUND
 *
 * A double-click would issue two refunds. Read-then-write is not a claim; an
 * atomic conditional update is.
 *
 * @returns {Promise<Object|null>} the claimed run, or null if already claimed
 */
async function claimRun(runId) {
  if (!isConnected()) return null;

  return AgentRun.findOneAndUpdate(
    { runId, status: "awaiting_confirmation" },
    { status: "resuming", claimedAt: new Date() },
    { returnDocument: "after" }
  ).lean();
}

/**
 * Release a claim if the resume failed.
 *
 * Without this, a crash mid-resume leaves the run stuck in "resuming" forever -
 * invisible to the queue and impossible to approve. Claiming something you
 * might not finish requires a way to un-claim it.
 */
async function releaseRun(runId) {
  if (!isConnected()) return;
  await AgentRun.updateOne(
    { runId, status: "resuming" },
    { status: "awaiting_confirmation", claimedAt: null }
  );
}

/**
 * Expire approvals nobody answered in time.
 *
 * Returns the expired runs so the caller can resume each one as a rejection -
 * the customer should hear "this could not be approved in time", not silence.
 */
async function expireStale() {
  if (!isConnected()) return [];

  const cutoff = new Date(Date.now() - APPROVAL_TTL_MS);
  const stale = await AgentRun.find({
    status: "awaiting_confirmation",
    createdAt: { $lt: cutoff },
  }).lean();

  return stale;
}

module.exports = {
  listPending,
  getPending,
  claimRun,
  releaseRun,
  expireStale,
  APPROVAL_TTL_MS,
};
