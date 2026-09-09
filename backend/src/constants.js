/**
 * constants.js
 *
 * The words this system agrees on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Before it, the string "awaiting_confirmation" was written out by hand in
 * SIX files - the agent loop, the approvals module, the coordinator, the
 * Mongoose schema, the HTTP layer and the voice session. Seventeen copies of
 * one word, with nothing connecting them.
 *
 * That is not a style problem. A typo in any one of them fails SILENTLY:
 *
 *   - a query for "awaiting_confirmaton" matches nothing, so the approval
 *     queue quietly loses a row and a customer waits forever
 *   - a status written as "awaiting-confirmation" passes Mongoose's enum
 *     check only if the enum happens to be wrong too
 *
 * The same class of bug already bit this project twice with a different
 * shape: `requiresOperator` was READ in two files and SET in none, so every
 * approval was handed to the customer; and Mongoose's `route` enum silently
 * accepted "specialist" for 28 runs before anyone added it to the list.
 *
 * Both would have been impossible if the vocabulary lived in one place.
 *
 * THE RULE: if two files need to agree on a string, it belongs here. If only
 * one file uses it, leave it where it is - a constant with a single caller is
 * indirection, not clarity.
 */

/**
 * How a run ended, or has not ended yet.
 *
 * The lifecycle:
 *
 *   RUNNING ─────────────► COMPLETE          the ordinary path
 *      │
 *      └──► AWAITING_CONFIRMATION            paused on a write tool
 *                  │
 *                  ├──► RESUMING ──► COMPLETE   a human approved it
 *                  ├──► EXPIRED                 nobody answered in 24h
 *                  └──► FAILED                  the resume itself broke
 *
 * AWAITING_CONFIRMATION is the one that matters: it is both a status and a
 * claim. `findOneAndUpdate({ status: AWAITING_CONFIRMATION }, ...)` is how
 * two clicks on Approve cannot refund twice - the status IS the lock.
 */
const RUN_STATUS = Object.freeze({
  COMPLETE: "complete",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  RESUMING: "resuming",
  EXPIRED: "expired",
  FAILED: "failed",
});

/**
 * How much agent a request gets.
 *
 * Ordered cheapest first, which is also the order the router tries them.
 * The whole argument for this layer is that most traffic never reaches
 * AUTONOMOUS - measured at 12% here.
 */
const ROUTES = Object.freeze({
  /** No LLM at all. A database lookup and a template. ~12ms, 0 tokens. */
  WORKFLOW: "workflow",
  /** The real agent loop, handed a smaller toolbox. */
  GUIDED: "guided",
  /** The full agent, every tool. For anything novel. */
  AUTONOMOUS: "autonomous",
  /** One delegated specialist agent (Build 3). */
  SPECIALIST: "specialist",
  /** The coordinator's own record of a multi-agent run. */
  MULTI_AGENT: "multi_agent",
});

/**
 * Named workflows - the deterministic, no-LLM handlers.
 *
 * These are `workflow` values, not routes. A request routed to WORKFLOW
 * carries one of these to say WHICH template answers it.
 */
const WORKFLOWS = Object.freeze({
  ORDER_STATUS: "order_status",
  ORDER_STATUS_BARE: "order_status_bare",
  /** Greetings, names, thanks - conversation, not a support request. */
  SOCIAL: "social",
  /** Off-topic. Refused for zero tokens, before any agent runs. */
  OUT_OF_SCOPE: "out_of_scope",
});

/** Message roles, as the provider APIs define them. */
const ROLES = Object.freeze({
  SYSTEM: "system",
  USER: "user",
  ASSISTANT: "assistant",
  TOOL: "tool",
});

module.exports = { RUN_STATUS, ROUTES, WORKFLOWS, ROLES };
