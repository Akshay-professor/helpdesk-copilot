/**
 * persistence.js
 *
 * Saves agent runs and tool calls to MongoDB.
 *
 * THE RULE THIS FILE FOLLOWS: SAVING MUST NEVER BREAK A RUN.
 *
 * Every function here swallows its own errors and logs them. If MongoDB is
 * down, mid-restart, or the disk is full, the customer still gets their answer.
 *
 * That is a real trade-off, not laziness. We are choosing to lose OBSERVABILITY
 * rather than lose SERVICE. It is defensible only because nothing here is load
 * bearing for correctness - the safety rails are pure JavaScript and never
 * touch the database.
 *
 * Build 2 changes that calculus: once a paused approval lives in MongoDB, a
 * failed write means a lost refund request, and this file will need to start
 * reporting failures upward instead of swallowing them. Flagged so the decision
 * gets revisited rather than inherited.
 */

const { isConnected } = require("./connection");
const { AgentRun, ToolCall } = require("./models");

/**
 * Persist a finished (or paused) agent run, plus one record per tool call.
 *
 * @param {Object} run - the result object from runLoop
 */
async function saveRun(run) {
  if (!isConnected()) return;

  try {
    await AgentRun.findOneAndUpdate(
      { runId: run.runId },
      {
        runId: run.runId,
        conversationId: run.conversationId,
        callerId: run.callerId,
        plan: run.plan ?? null,
        planRevisions: run.planRevisions ?? 0,
        revisions: run.revisions ?? 0,
        reflections: run.reflections ?? [],
        route: run.route ?? null,
        routeReason: run.routeReason ?? null,
        specialist: run.specialist ?? null,
        userMessage: run.userMessage,
        reply: run.reply,
        status: run.status,
        stoppedReason: run.stoppedReason,
        iterations: run.iterations,
        tokensUsed: run.tokensUsed,
        durationMs: run.startedAt ? Date.now() - run.startedAt : undefined,
        trace: run.trace,
        messages: run.messages,
        // Only present while paused. This is what Build 2 reads to resume a
        // run on a different server instance.
        pending: run.pending ?? null,
        completedAt: run.status === "complete" ? new Date() : undefined,
      },
      // upsert: create if absent, update if present. A run is saved twice -
      // once when it pauses, once when it completes - and both must land on
      // the same document rather than creating two.
      { upsert: true, returnDocument: 'after' }
    );

    // Tool calls also stored separately, so you can query ACROSS runs:
    // "how often does getCustomer fail?", "p95 duration of issueRefund".
    // The embedded trace copy cannot answer those efficiently.
    const calls = [];
    for (const entry of run.trace ?? []) {
      for (const c of entry.toolCalls ?? []) {
        calls.push({
          runId: run.runId,
          toolCallId: c.id,
          name: c.name,
          iteration: entry.iteration,
          arguments: safeParse(c.rawArguments),
          result: c.result,
          ok: c.ok,
          errorCode: c.result?.error ?? null,
          durationMs: c.durationMs,
          isWrite: c.confirmed !== undefined,
          confirmed: c.confirmed,
          modified: c.modified,
        });
      }
    }

    if (calls.length > 0) {
      // Replace rather than append: a resumed run re-saves its whole trace,
      // and without this the earlier tool calls would be duplicated.
      await ToolCall.deleteMany({ runId: run.runId });
      await ToolCall.insertMany(calls);
    }
  } catch (err) {
    console.error(`[persist] failed to save run ${run.runId}:`, err.message);
  }
}

/** Load a run by its correlation ID. */
async function loadRun(runId) {
  if (!isConnected()) return null;
  try {
    return await AgentRun.findOne({ runId }).lean();
  } catch (err) {
    console.error(`[persist] failed to load run ${runId}:`, err.message);
    return null;
  }
}

/** Recent runs, newest first — for the trace viewer. */
async function listRuns(limit = 20) {
  if (!isConnected()) return [];
  try {
    return await AgentRun.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("runId status reply iterations tokensUsed stoppedReason createdAt")
      .lean();
  } catch (err) {
    console.error("[persist] failed to list runs:", err.message);
    return [];
  }
}

function safeParse(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    // Keep the unparseable string rather than dropping it - a malformed
    // argument is exactly the kind of thing you want to see in a trace.
    return { _unparsed: String(raw).slice(0, 500) };
  }
}

module.exports = { saveRun, loadRun, listRuns };
