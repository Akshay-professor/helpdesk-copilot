/**
 * models.js
 *
 * Mongoose schemas — the shape of everything we store.
 *
 * A "schema" is a description of what a document looks like: which fields
 * exist, their types, which are required. Mongoose enforces it on every write,
 * so a typo like `custmerId` is rejected instead of silently creating a new
 * field nobody ever reads again.
 *
 * MongoDB itself does not require this — it will happily store any shape. The
 * schema is a discipline we impose, and it is worth it: the alternative is a
 * collection where half the documents spell a field one way and half another.
 *
 * The assignment names exactly what must be stored:
 *   "MongoDB: conversations, messages, tool call records (with args, results,
 *    duration, success/failure), customers, orders, invoices, refunds"
 */

const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// Business data
// ---------------------------------------------------------------------------

const customerSchema = new mongoose.Schema(
  {
    // Our own IDs (cus_001) rather than Mongo's _id, because the agent passes
    // these around in tool arguments and "cus_001" is far easier to read in a
    // trace than "507f1f77bcf86cd799439011".
    id: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    tier: { type: String, enum: ["standard", "gold"], default: "standard" },
    accountCredit: { type: Number, default: 0, min: 0 },
    joinedAt: String,
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    customerId: { type: String, required: true, index: true },
    description: String,
    total: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["pending", "shipped", "delivered", "cancelled"],
      required: true,
    },
    placedAt: String,
    deliveredAt: String,
    // Guarded at the database level too. Defence in depth: even a bug in our
    // tool code cannot write a negative refund total.
    refundedAmount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

const invoiceSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    customerId: { type: String, required: true, index: true },
    orderId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ["paid", "unpaid", "void"], default: "paid" },
    issuedAt: String,
    note: { type: String, default: null },
  },
  { timestamps: true }
);

const refundSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    orderId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    reason: String,
    issuedAt: String,
    // Which agent run issued this. Lets you answer "why was this refunded?"
    // by pulling up the entire conversation that led to it.
    runId: { type: String, index: true },
  },
  { timestamps: true }
);

const escalationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    reason: { type: String, required: true },
    priority: {
      type: String,
      enum: ["low", "normal", "high", "urgent"],
      required: true,
    },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    createdAt: String,
    runId: { type: String, index: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Agent observability
// ---------------------------------------------------------------------------

/**
 * One agent run — everything that happened between a user's message and the
 * agent's answer.
 *
 * `runId` is the correlation ID the assignment requires: "one request may
 * involve 8 LLM calls and 15 tool executions; that must be reconstructable
 * from logs." Every log line and every record created during a run carries it,
 * so `runId` is the single string that pulls the whole story back together.
 */
const agentRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, index: true },

    userMessage: String,
    reply: String,

    status: {
      type: String,
      // "resuming" is the CLAIMED state - see approvals.claimRun(). A run
      // sits here only between an approval being accepted and the resume
      // finishing, which is what makes double-approval impossible.
      enum: ["complete", "awaiting_confirmation", "resuming", "expired", "failed"],
      required: true,
    },
    stoppedReason: String,

    iterations: Number,
    tokensUsed: Number,
    durationMs: Number,

    // The full trace. `Mixed` means "any shape" — deliberate here, because a
    // tool result can be anything a tool returns and we must not lose detail
    // by forcing it into a fixed shape.
    trace: { type: mongoose.Schema.Types.Mixed, default: [] },

    // The conversation as sent to the LLM. Lets a run be replayed exactly.
    messages: { type: mongoose.Schema.Types.Mixed, default: [] },

    // Present only while a run is paused for confirmation. This is what makes
    // Build 2's "survive a server restart" requirement work: the paused state
    // lives here, so any server instance can pick the run up and resume it.
    pending: { type: mongoose.Schema.Types.Mixed, default: null },

    // Who the run belongs to. Without this a run resumed FROM THE DATABASE
    // loses its authorization badge and the confirmed write runs as nobody.
    callerId: { type: String, index: true },

    // When an operator claimed this approval.
    claimedAt: Date,

    // When the expiry sweep gave up on an unanswered approval. Kept as its own
    // field rather than reusing completedAt, because "nobody answered" and
    // "the agent finished" are different outcomes and an audit trail should
    // not blur them.
    expiredAt: Date,

    // The execution plan, if this request was classified as multi-step.
    // Persisted because the assignment requires plans and their revisions to
    // be inspectable afterwards.
    plan: { type: mongoose.Schema.Types.Mixed, default: null },
    planRevisions: { type: Number, default: 0 },

    // Reflection: how many times the draft was rejected, and the full record
    // of each rejection INCLUDING the rejected draft itself. The assignment:
    // "you need to see what was rejected and why, and this becomes your
    // quality dataset."
    revisions: { type: Number, default: 0 },
    reflections: { type: mongoose.Schema.Types.Mixed, default: [] },

    // Which path handled this request. Indexed because the whole argument for
    // the routing layer is a percentage, and you cannot compute it without
    // grouping on this field.
    // Build 3 added "specialist" (one delegated agent) and "multi_agent" (the
    // coordinator's own record).
    //
    // Worth noting what happened here: 28 runs were stored with
    // route: "specialist" BEFORE it was added to this enum. Mongoose enum
    // validation does not run on findOneAndUpdate with upsert unless
    // runValidators is set, so the writes went through silently. The enum was
    // documentation, not a constraint - which is worth knowing before relying
    // on one.
    route: {
      type: String,
      enum: ["workflow", "guided", "autonomous", "specialist", "multi_agent"],
      index: true,
    },
    routeReason: String,

    // WHICH specialist handled this, when one did.
    //
    // The assignment marks per-agent cost tracking separately from routing:
    // "multi-agent multiplies LLM calls; the numbers you see here are your
    // evidence for the written analysis". Grouping by `route` tells you
    // specialists cost more; grouping by THIS tells you which one, which is
    // the number that actually changes a decision.
    specialist: { type: String, default: null, index: true },

    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  { timestamps: true }
);

/**
 * One tool execution.
 *
 * These are also embedded inside the run's trace. Storing them separately as
 * well is deliberate — it lets you ask questions across ALL runs that the
 * embedded copy cannot answer efficiently:
 *
 *   "How often does getCustomer fail?"
 *   "What is the p95 duration of checkRefundEligibility?"
 *   "Show me every refund attempt blocked by policy this week."
 *
 * The assignment asks for "tool call records (with args, results, duration,
 * success/failure)" as its own thing, and this is why.
 */
const toolCallSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, index: true },
    toolCallId: String,
    name: { type: String, required: true, index: true },
    iteration: Number,

    arguments: { type: mongoose.Schema.Types.Mixed },
    result: { type: mongoose.Schema.Types.Mixed },

    ok: { type: Boolean, index: true },
    errorCode: { type: String, index: true },
    durationMs: Number,

    // Confirmation flow metadata
    isWrite: { type: Boolean, default: false },
    confirmed: Boolean,
    modified: Boolean,
  },
  { timestamps: true }
);

/**
 * A research investigation and its report.
 *
 * The assignment: research is "LONG-RUNNING: streams progress, and must
 * survive being closed and reopened."
 *
 * That second half is why this collection exists. A chat reply is disposable -
 * ask again and you get another one. A research report took multiple LLM calls
 * and a fan-out across several data sources; losing it because someone closed
 * a tab would mean paying for it twice.
 *
 * So a row is written when the investigation STARTS (status "investigating"),
 * not when it finishes. If the process dies mid-run, the question and the plan
 * survive - exactly the reasoning that put the paused approval in MongoDB in
 * Build 2.
 */
const researchReportSchema = new mongoose.Schema(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    question: { type: String, required: true },
    callerId: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: ["investigating", "complete", "failed"],
      default: "investigating",
      index: true,
    },

    // The sub-questions it decided to investigate. Stored even while the run
    // is in flight, so a resumed view can show what is being worked on.
    subQuestions: { type: mongoose.Schema.Types.Mixed, default: [] },

    report: String,

    // Computed in code from evidence, never asked of the model - see
    // researchAgent.js assessConfidence().
    confidence: { type: String, enum: ["high", "medium", "low"], index: true },
    confidenceReason: String,

    // "What it could not determine." The assignment marks this explicitly, and
    // it is stored as structured data rather than prose so it can be counted,
    // displayed separately, and audited later.
    gaps: { type: mongoose.Schema.Types.Mixed, default: [] },

    // Every distinct source consulted - the report's bibliography.
    citations: { type: mongoose.Schema.Types.Mixed, default: [] },

    tokensUsed: { type: Number, default: 0 },
    durationMs: Number,
    synthesisFailed: { type: String, default: null },

    startedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const Customer = mongoose.model("Customer", customerSchema);
const Order = mongoose.model("Order", orderSchema);
const Invoice = mongoose.model("Invoice", invoiceSchema);
const Refund = mongoose.model("Refund", refundSchema);
const Escalation = mongoose.model("Escalation", escalationSchema);
const AgentRun = mongoose.model("AgentRun", agentRunSchema);
const ToolCall = mongoose.model("ToolCall", toolCallSchema);
const ResearchReport = mongoose.model("ResearchReport", researchReportSchema);

module.exports = {
  Customer,
  Order,
  Invoice,
  Refund,
  Escalation,
  AgentRun,
  ToolCall,
  ResearchReport,
};
