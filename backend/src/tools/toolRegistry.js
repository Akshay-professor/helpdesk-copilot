/**
 * toolRegistry.js
 *
 * The hands. Every action the agent can take is registered here.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *   Adding a tool must be ONE registration, with ZERO changes to the agent
 *   loop. If you ever find yourself editing agentRunner.js to add a tool,
 *   the design has broken.
 *
 * Each tool declares four things:
 *   - name        what the model calls it
 *   - description what the model reads to decide WHEN to call it
 *   - parameters  a JSON schema describing its arguments
 *   - handler     the actual JavaScript that runs
 *
 * Data comes from src/data/seed.js. At Step 7 that module starts reading from
 * MongoDB instead of returning arrays, and nothing in this file changes.
 */

const { REFUND_POLICY } = require("../data/seed");
const repo = require("../data/repository");
const vectorStore = require("../rag/vectorStore");
const { requireOwnership } = require("../policy/authorization");

const {
  TIER,
  LIMITS,
  ESCALATION_PRIORITIES,
  checkRefundAmount,
  checkCreditAmount,
} = require("../policy/policy");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a structured tool error.
 *
 * The assignment is explicit that a rejected or failed tool must return a
 * structured error the agent can REASON ABOUT - not a thrown exception that
 * kills the loop:
 *
 *   throw new Error("no customer")   -> loop dies, user sees a 502
 *   return { error: "not_found" }    -> model reads it and says "I could not
 *                                       find that account, could you confirm
 *                                       the email address?"
 *
 * Failure becomes information. That is the whole point of an agent.
 */
function toolError(code, message, details) {
  return { error: code, message, ...(details && { details }) };
}

/** Whole days between an ISO date string and now. */
function daysSince(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

/**
 * THE CORRELATION ID
 *
 * The assignment requires "structured logging with a correlation ID per agent
 * run - one request may involve 8 LLM calls and 15 tool executions; that must
 * be reconstructable from logs." Records a tool writes (refunds, escalations)
 * carry this `runId`, so any of them traces back to the exact conversation that
 * produced it.
 *
 * It is passed as an argument through executeTool -> handler, NOT stored in a
 * module-level variable. That distinction matters: Node serves many requests in
 * one process, so a shared variable would be overwritten by whichever request
 * ran most recently. Two customers refunding at the same moment would tag each
 * other's records.
 *
 * Anything request-scoped must be passed down, never stored at module level.
 */

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = {
  // -------------------------------------------------------------------------
  searchKnowledgeBase: {
    description:
      "Search company policy documents and help articles. Use this for ANY " +
      "question about policy - refund windows, shipping times, account rules, " +
      "what is or is not allowed. You must never state a policy from memory: " +
      "look it up here and cite the document. If this returns nothing " +
      "relevant, tell the customer you cannot determine the answer and offer " +
      "to escalate.",

    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, in plain language. Use the customer's own " +
            "words - the search matches on meaning, not keywords.",
        },
        limit: {
          type: "integer",
          description: "How many documents to return (1-5, default 3).",
          minimum: 1,
          maximum: 5,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },

    handler: async ({ query, limit = 3 }, ctx = {}) => {
      // ctx.kbCategories is set when a Build 3 specialist is running. The
      // billing agent searches the billing slice; it cannot retrieve, cite, or
      // even see the account-deletion policy. Same badge that carries
      // identity, now also carrying scope.
      const { available, results } = await vectorStore.search(query, limit, {
        categories: ctx.kbCategories,
      });

      if (!available) {
        // Chroma is down. Say so plainly rather than returning an empty list,
        // which the model could read as "no such policy exists" and then
        // confidently tell a customer the wrong thing.
        return toolError(
          "knowledge_base_unavailable",
          "The policy knowledge base cannot be reached right now. Do not " +
            "answer policy questions from memory - tell the customer you " +
            "cannot look it up and offer to escalate."
        );
      }

      // THE RELEVANCE FLOOR.
      //
      // Vector search ALWAYS returns its closest matches, even for a question
      // with no answer in the corpus. Asked "what is the capital of France",
      // it happily returns the Duplicate Charges document at 0.59.
      //
      // Without this cut-off the agent would cite that document and produce a
      // grounded-looking answer to a question we have no information about -
      // which is the exact hallucination RAG is supposed to prevent, now
      // wearing a citation.
      //
      // 0.65 sits between the observed real matches (0.70-0.76) and the
      // observed nonsense match (0.59). Worth re-tuning if the corpus changes.
      const RELEVANCE_FLOOR = 0.65;
      const relevant = results.filter((r) => r.score >= RELEVANCE_FLOOR);

      if (relevant.length === 0) {
        return {
          query,
          found: 0,
          documents: [],
          message:
            "No policy document covers this question. Tell the customer you " +
            "cannot determine the answer and offer to escalate to a human. " +
            "Do not guess.",
          ...(results.length > 0 && {
            closestButBelowThreshold: results[0].title,
            closestScore: results[0].score,
          }),
        };
      }

      return {
        query,
        found: relevant.length,
        // `citation` is the string the agent should quote back. Making it an
        // explicit field, rather than expecting the model to assemble one from
        // an id and a title, makes citing the easy path.
        documents: relevant.map((r) => ({
          citation: `${r.title} (${r.id})`,
          title: r.title,
          id: r.id,
          category: r.category,
          relevance: r.score,
          text: r.text,
        })),
        instruction:
          "Base your answer only on these documents and cite the title of " +
          "each one you use. If they do not fully answer the question, say " +
          "what is missing rather than filling the gap yourself.",
      };
    },
  },

  // -------------------------------------------------------------------------
  getCustomer: {
    description:
      "Look up a customer account by their email address. Returns the " +
      "customer's ID, name, account tier, and available account credit. " +
      "Use this first when a request concerns a specific customer, since " +
      "other tools need the customer ID.",

    // JSON Schema. This is what the model reads to learn the shape of the
    // arguments. `additionalProperties: false` matters: without it the model
    // can invent extra fields and we would silently accept them.
    parameters: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "The customer's email address, e.g. alice@shop.com",
        },
      },
      required: ["email"],
      additionalProperties: false,
    },

    handler: async ({ email }, ctx = {}) => {
      // Validate INSIDE the handler too. The schema proved it is a string;
      // only the handler knows what a MEANINGFUL value looks like here.
      if (!email.includes("@")) {
        return toolError(
          "invalid_email",
          "That does not look like a valid email address."
        );
      }

      // ---- THE MODEL WILL INVENT AN EMAIL IF YOU LET IT -----------------
      //
      // A customer typed "i am alice". The agent called this tool with
      // "alice@example.com" - a plausible-looking address nobody had said -
      // and then told them their account could not be found.
      //
      // The system prompt already says "never invent account information".
      // The model did it anyway, which is the whole lesson of this project
      // restated: a prompt is a suggestion, a code check is a guarantee.
      //
      // These are the reserved documentation domains (RFC 2606). They exist
      // precisely to be used in examples, so they are exactly what a model
      // reaches for when it is filling in a blank rather than reading one.
      // No real customer will ever have one.
      const PLACEHOLDER_DOMAINS = [
        "example.com",
        "example.org",
        "example.net",
        "email.com",
        "domain.com",
        "test.com",
        "yourdomain.com",
      ];
      const domain = email.split("@")[1]?.toLowerCase() ?? "";

      if (PLACEHOLDER_DOMAINS.includes(domain)) {
        // Told to the MODEL, not the customer - it is the model that needs
        // to change behaviour, and it can now ask the question it should
        // have asked in the first place.
        return toolError(
          "email_not_provided",
          `"${email}" is a placeholder address, not something the customer ` +
            `told you. Do not guess an email. Ask the customer for the ` +
            `address on their account and call this tool again with it.`
        );
      }

      const customer = await repo.findCustomerByEmail(email);

      if (!customer) {
        return toolError(
          "customer_not_found",
          `No customer account exists for ${email}.`
        );
      }

      // THE GUARD. The model guessed "Alice" -> alice@shop.com and was right,
      // because there is one Alice. This line does not care how confident the
      // guess was, and cannot be talked out of it.
      const denied = requireOwnership(ctx, customer.id, email);
      if (denied) return denied;

      return customer;
    },
  },

  // -------------------------------------------------------------------------
  getOrders: {
    description:
      "List a customer's orders, most recent first. Requires a customer ID " +
      "(use getCustomer first to find it from an email address). Returns " +
      "each order's ID, description, total, status, and dates.",

    parameters: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description: "The customer's ID, e.g. cus_001",
        },
        // OUR FIRST OPTIONAL PARAMETER - note it is absent from `required`.
        //
        // The minimum/maximum are not decoration. Without a maximum the model
        // can ask for 100000 orders and we would try to serve it. Bound
        // anything the model can influence.
        limit: {
          type: "integer",
          description: "Maximum number of orders to return (1-50, default 10).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["customerId"],
      additionalProperties: false,
    },

    handler: async ({ customerId, limit = 10 }, ctx = {}) => {
      // Ownership BEFORE existence. Checking existence first turns the tool
      // into an oracle: probe IDs and watch which say "not found" versus
      // "not authorized". Same reasoning as issueRefund checking policy
      // before looking up the order.
      const denied = requireOwnership(ctx, customerId, customerId);
      if (denied) return denied;

      const customer = await repo.findCustomerById(customerId);
      if (!customer) {
        return toolError(
          "customer_not_found",
          `No customer exists with ID ${customerId}.`
        );
      }

      const orders = await repo.findOrdersByCustomer(customerId, limit);

      // An empty list is NOT an error. "This customer has no orders" is a
      // legitimate, useful answer. Reserve errors for things that went wrong.
      return { customerId, count: orders.length, orders };
    },
  },

  // -------------------------------------------------------------------------
  getInvoices: {
    description:
      "List a customer's invoices, most recent first. Requires a customer " +
      "ID. Each invoice shows its amount, status, issue date, the order it " +
      "belongs to, and any note explaining a billing anomaly. Use this to " +
      "investigate billing questions such as duplicate or unexpected charges.",

    parameters: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description: "The customer's ID, e.g. cus_001",
        },
      },
      required: ["customerId"],
      additionalProperties: false,
    },

    handler: async ({ customerId }, ctx = {}) => {
      const denied = requireOwnership(ctx, customerId, customerId);
      if (denied) return denied;

      const customer = await repo.findCustomerById(customerId);
      if (!customer) {
        return toolError(
          "customer_not_found",
          `No customer exists with ID ${customerId}.`
        );
      }

      const invoices = await repo.findInvoicesByCustomer(customerId);

      // Flag likely duplicates rather than leaving the model to eyeball dates
      // and amounts. "Two invoices, same order, same amount, same day" is a
      // factual observation our code can make reliably - so it should. The
      // model's job is explaining and acting on it, not spotting it.
      const duplicates = [];
      for (let i = 0; i < invoices.length; i++) {
        for (let j = i + 1; j < invoices.length; j++) {
          const a = invoices[i];
          const b = invoices[j];
          if (
            a.orderId === b.orderId &&
            a.amount === b.amount &&
            a.issuedAt === b.issuedAt
          ) {
            duplicates.push({
              orderId: a.orderId,
              amount: a.amount,
              invoiceIds: [a.id, b.id],
            });
          }
        }
      }

      return {
        customerId,
        count: invoices.length,
        invoices,
        ...(duplicates.length > 0 && { possibleDuplicates: duplicates }),
      };
    },
  },

  // -------------------------------------------------------------------------
  checkRefundEligibility: {
    // The assignment is explicit: "Evaluates policy rules - the agent must NOT
    // decide eligibility itself."
    //
    // That constraint is why this tool exists at all. Without it the model
    // would look at an order and reason "delivered 12 days ago, that is within
    // 30 days, so it is eligible" - and a model that reasons its way to a
    // verdict can be argued into a different one. The rules live in code here;
    // the agent only reads the answer.
    description:
      "Check whether an order is eligible for a refund under company policy. " +
      "Returns a definitive eligible/not-eligible verdict, the reason, and " +
      "the maximum refundable amount. You MUST use this tool to determine " +
      "eligibility - never decide it yourself from order details.",

    parameters: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "The order's ID, e.g. ord_1001",
        },
      },
      required: ["orderId"],
      additionalProperties: false,
    },

    handler: async ({ orderId }, ctx = {}) => {
      const order = await repo.findOrderById(orderId);
      if (!order) {
        return toolError(
          "order_not_found",
          `No order exists with ID ${orderId}.`
        );
      }

      // An order ID does not carry its owner, so unlike getOrders we must
      // load the record before we can check. The lookup is unavoidable here;
      // what matters is that nothing is RETURNED before the check.
      const denied = requireOwnership(ctx, order.customerId, orderId);
      if (denied) return denied;

      // Each branch names the rule it applied, so the agent can EXPLAIN the
      // decision rather than only report it.
      const base = { orderId, orderTotal: order.total, status: order.status };

      if (!REFUND_POLICY.eligibleStatuses.includes(order.status)) {
        return {
          ...base,
          eligible: false,
          reason:
            order.status === "cancelled"
              ? "Order was cancelled and never charged, so there is nothing to refund."
              : `Order status is "${order.status}". Only delivered orders can be refunded.`,
          policyRule: "eligible_statuses",
          maxRefundable: 0,
        };
      }

      const age = daysSince(order.deliveredAt);
      if (age > REFUND_POLICY.windowDays) {
        return {
          ...base,
          eligible: false,
          reason: `Delivered ${age} days ago, outside the ${REFUND_POLICY.windowDays}-day refund window.`,
          policyRule: "refund_window",
          daysSinceDelivery: age,
          maxRefundable: 0,
        };
      }

      const remaining = order.total - order.refundedAmount;
      if (remaining <= 0) {
        return {
          ...base,
          eligible: false,
          reason: `Order has already been fully refunded ($${order.refundedAmount.toFixed(2)}).`,
          policyRule: "already_refunded",
          maxRefundable: 0,
        };
      }

      return {
        ...base,
        eligible: true,
        reason: `Delivered ${age} days ago, within the ${REFUND_POLICY.windowDays}-day window.`,
        policyRule: "within_window",
        daysSinceDelivery: age,
        alreadyRefunded: order.refundedAmount,
        maxRefundable: Number(remaining.toFixed(2)),
      };
    },
  },

  // ==========================================================================
  // WRITE TOOLS - everything below here has side effects.
  //
  // The assignment: "Hard policy limits enforced in code, not in the prompt.
  // A prompt saying 'never refund over $500' is a suggestion; a code check is
  // a guarantee."
  //
  // Every limit below is a JavaScript comparison in this file. No amount of
  // persuasive text reaching the model can move one of them, because the model
  // never executes anything - it only ever asks, and these functions decide.
  // ==========================================================================

  // -------------------------------------------------------------------------
  issueRefund: {
    description:
      "Issue a refund against an order. IRREVERSIBLE - money leaves the " +
      "company. You must call checkRefundEligibility first and confirm the " +
      "order is eligible. The amount must not exceed the maxRefundable value " +
      "that tool returned. Refunds above the policy limit will be rejected " +
      "and require human approval.",

    // Marks this as a side-effecting action. The loop reads this flag for the
    // confirmation flow; read tools run freely, writes announce themselves.
    write: true,

    /**
     * Plain-English description of what confirming this will do.
     *
     * The assignment requires the confirmation to show "exactly what will
     * happen before it happens". Raw JSON arguments are not that - a person
     * approving a refund should read a sentence, not parse a payload.
     *
     * Each write tool owns its own summary, so the loop never has to know how
     * to describe a refund. Adding a write tool stays one registration.
     */
    summarize: ({ orderId, amount, reason }) => {
      // Synchronous on purpose: this only builds a confirmation sentence, and
      // making it async would force the pause path to await a DB read purely
      // for cosmetics. Names are looked up later by the UI if needed.
      return {
        action: "Issue a refund",
        detail: `Refund $${Number(amount).toFixed(2)} for order ${orderId}`,
        reason,
        irreversible: true,
        warning: "Money leaves the company. This cannot be undone.",
      };
    },

    parameters: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "The order to refund, e.g. ord_1001",
        },
        amount: {
          type: "number",
          description: "Amount to refund in dollars. Must be greater than 0.",
          minimum: 0.01,
        },
        reason: {
          type: "string",
          description:
            "Why this refund is being issued, e.g. 'Duplicate charge caused " +
            "by payment gateway retry'.",
        },
      },
      required: ["orderId", "amount", "reason"],
      additionalProperties: false,
    },

    handler: async ({ orderId, amount, reason }, ctx = {}) => {
      // ---- 1. THE POLICY CHECK ----------------------------------------
      // Deliberately FIRST, before we even confirm the order exists.
      //
      // Why order matters: an over-limit request should be refused because it
      // is over the limit, not leak information about which order IDs are
      // real. Refuse on policy before doing any lookup.
      const decision = checkRefundAmount(amount);

      if (decision.tier === TIER.REFUSE) {
        return toolError("policy_violation", decision.reason, {
          requestedAmount: amount,
          limit: decision.limit,
          tier: decision.tier,
        });
      }

      if (decision.tier === TIER.NEEDS_APPROVAL && !ctx.approved) {
        // ---- THE BUG THIS GUARD FIXES ---------------------------------
        //
        // The `!ctx.approved` half was missing, and the comment here used to
        // promise that "Build 2 replaces this branch with a genuine pause".
        // Build 2 never did. So the two layers disagreed:
        //
        //   agentRunner  pauses BEFORE the tool runs, gets human approval,
        //                then calls the tool
        //   this tool    refuses anyway, because it had no idea a human had
        //                just said yes
        //
        // The customer saw: confirmation modal -> Approve -> "I've escalated
        // this to a human agent". An approval that leads to being told you
        // need an approval.
        //
        // ctx.approved is set only by resumeAgent, only after a real human
        // decision has been recorded. It is not something the model can ask
        // for - the model has no way to put it in ctx.
        //
        // The ceiling above (TIER.REFUSE) is deliberately NOT relaxed by this
        // flag. Approval changes WHO asked; it never changes WHAT IS ALLOWED.
        return toolError("approval_required", decision.reason, {
          requestedAmount: amount,
          autoApproveLimit: decision.limit,
          tier: decision.tier,
          nextStep:
            "Explain this to the customer and use escalateToHuman to raise " +
            "it for manual approval.",
        });
      }

      // ---- 2. Does the order exist? -----------------------------------
      const order = await repo.findOrderById(orderId);
      if (!order) {
        return toolError("order_not_found", `No order exists with ID ${orderId}.`);
      }

      // Refunding someone else's order is worse than reading it.
      const denied = requireOwnership(ctx, order.customerId, orderId);
      if (denied) return denied;

      // ---- 3. RE-CHECK ELIGIBILITY --------------------------------------
      // The model was TOLD to call checkRefundEligibility first. We do not
      // trust that it did, or that it read the answer correctly.
      //
      // This is the difference between an instruction and a guarantee. The
      // description asks; this code enforces. Never rely on the agent having
      // performed a safety check - perform it again where it matters.
      const eligibility = await TOOLS.checkRefundEligibility.handler(
        { orderId },
        ctx
      );

      if (eligibility.error) return eligibility;

      if (!eligibility.eligible) {
        return toolError(
          "not_eligible",
          `Order ${orderId} is not eligible for a refund. ${eligibility.reason}`,
          { policyRule: eligibility.policyRule }
        );
      }

      if (amount > eligibility.maxRefundable) {
        return toolError(
          "amount_exceeds_refundable",
          `Cannot refund $${amount.toFixed(2)} - the maximum refundable amount ` +
            `for order ${orderId} is $${eligibility.maxRefundable.toFixed(2)}.`,
          { requested: amount, maxRefundable: eligibility.maxRefundable }
        );
      }

      // ---- 4. Everything checks out. Do it. ----------------------------
      const rounded = Number(amount.toFixed(2));

      const { refund, order: updated } = await repo.recordRefund({
        orderId,
        customerId: order.customerId,
        amount: rounded,
        reason,
        runId: ctx.runId,
      });

      return {
        success: true,
        refundId: refund.id,
        orderId,
        amountRefunded: rounded,
        remainingRefundable: Number(
          (updated.total - updated.refundedAmount).toFixed(2)
        ),
        message: `Refund of $${rounded.toFixed(2)} issued for order ${orderId}.`,
      };
    },
  },

  // -------------------------------------------------------------------------
  applyAccountCredit: {
    description:
      "Add account credit to a customer's balance, for goodwill gestures or " +
      "as an alternative to a refund. Credit can only be spent with us, so " +
      "it is more readily granted than a refund - but it is still bounded by " +
      "policy and large amounts will be rejected.",

    write: true,

    // Synchronous on purpose: this only builds a confirmation sentence, so it
    // must not do I/O. Making it async would force the pause path to await a
    // database read purely for cosmetics.
    summarize: ({ customerId, amount, reason }) => {
      return {
        action: "Apply account credit",
        detail: `Add $${Number(amount).toFixed(2)} credit to ${customerId}`,
        reason,
        irreversible: false,
        warning: "Credit can be adjusted later if applied in error.",
      };
    },

    parameters: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description: "The customer's ID, e.g. cus_001",
        },
        amount: {
          type: "number",
          description: "Credit to apply in dollars. Must be greater than 0.",
          minimum: 0.01,
        },
        reason: {
          type: "string",
          description: "Why this credit is being applied.",
        },
      },
      required: ["customerId", "amount", "reason"],
      additionalProperties: false,
    },

    handler: async ({ customerId, amount, reason }, ctx = {}) => {
      // Policy first, again.
      const decision = checkCreditAmount(amount);

      if (decision.tier === TIER.REFUSE) {
        return toolError("policy_violation", decision.reason, {
          requestedAmount: amount,
          limit: decision.limit,
        });
      }

      // Same fix as issueRefund above: a human has already approved this by
      // the time the tool runs, so refusing again would strand the customer.
      if (decision.tier === TIER.NEEDS_APPROVAL && !ctx.approved) {
        return toolError("approval_required", decision.reason, {
          requestedAmount: amount,
          autoApproveLimit: decision.limit,
          nextStep:
            "Explain this to the customer and use escalateToHuman if they " +
            "want to pursue it.",
        });
      }

      const denied = requireOwnership(ctx, customerId, customerId);
      if (denied) return denied;

      const customer = await repo.findCustomerById(customerId);
      if (!customer) {
        return toolError(
          "customer_not_found",
          `No customer exists with ID ${customerId}.`
        );
      }

      const rounded = Number(amount.toFixed(2));

      // Must go through the repository. An earlier version mutated `customer`
      // directly - but repo reads use .lean(), which returns a DETACHED plain
      // object. Assigning to it changed a copy in memory and wrote nothing,
      // while still reporting the new balance, so the tool looked successful
      // and the database never moved.
      const updated = await repo.applyCredit({ customerId, amount: rounded });

      return {
        success: true,
        customerId,
        creditApplied: rounded,
        newBalance: updated.accountCredit,
        reason,
        message: `$${rounded.toFixed(2)} credit applied. New balance: $${updated.accountCredit.toFixed(2)}.`,
      };
    },
  },

  // -------------------------------------------------------------------------
  //
  // Build 3 added this one, and it is worth saying WHY.
  //
  // Writing the specialist agents exposed a gap nobody had noticed: every
  // write tool we owned moved money. So the assignment's own example of
  // isolation - "a billing agent that can't touch account-deletion tools
  // cannot misuse them" - was a claim we could not demonstrate, because there
  // were no account tools to withhold. Our four "specialists" were really one
  // billing agent and three read-only ones.
  //
  // A test that cannot fail is not proving anything. Adding a genuine account
  // ACTION is what makes the wall real rather than rhetorical.
  changePlan: {
    description:
      "Change a customer's plan tier between standard and gold. Use only " +
      "when the customer has clearly asked to upgrade or downgrade. Confirm " +
      "which tier they want before calling this - do not infer it.",

    write: true,

    summarize: ({ customerId, tier, reason }) => ({
      action: "Change plan tier",
      detail: `Move ${customerId} to the ${tier} tier`,
      reason,
      // Reversible in the database, but NOT in its effects - a downgrade can
      // cancel benefits the moment it lands, and re-upgrading does not undo
      // what was lost in between. Reversibility of the row is not the same as
      // reversibility of the consequence, which is the distinction our
      // autonomy policy is built on.
      irreversible: false,
      warning:
        "A downgrade takes effect immediately and may end benefits the " +
        "customer is currently using.",
    }),

    parameters: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description: "The customer's ID, e.g. cus_001",
        },
        tier: {
          type: "string",
          description: "The tier to move them to.",
          enum: ["standard", "gold"],
        },
        reason: {
          type: "string",
          description: "Why the plan is being changed.",
        },
      },
      required: ["customerId", "tier", "reason"],
      additionalProperties: false,
    },

    handler: async ({ customerId, tier, reason }, ctx = {}) => {
      // Enum checked here for the same reason escalateToHuman does it: our
      // validator is deliberately small, and a bad tier would otherwise reach
      // Mongoose and throw rather than returning a readable error.
      if (!["standard", "gold"].includes(tier)) {
        return toolError(
          "invalid_tier",
          `"${tier}" is not a valid tier. Valid tiers: standard, gold.`
        );
      }

      const denied = requireOwnership(ctx, customerId, customerId);
      if (denied) return denied;

      const customer = await repo.findCustomerById(customerId);
      if (!customer) {
        return toolError(
          "customer_not_found",
          `No customer exists with ID ${customerId}.`
        );
      }

      // Already there. Report it as a non-event rather than writing anyway -
      // an audit trail full of no-op changes hides the real ones.
      if (customer.tier === tier) {
        return {
          success: true,
          changed: false,
          customerId,
          tier,
          message: `${customerId} is already on the ${tier} tier. Nothing to change.`,
        };
      }

      const updated = await repo.changeTier({ customerId, tier });

      return {
        success: true,
        changed: true,
        customerId,
        previousTier: updated.previousTier,
        tier: updated.tier,
        reason,
        message: `Plan changed from ${updated.previousTier} to ${updated.tier}.`,
      };
    },
  },

  // -------------------------------------------------------------------------
  escalateToHuman: {
    description:
      "Raise this conversation to a human support agent. Use when you cannot " +
      "resolve a request yourself, when an action needs approval beyond your " +
      "limits, or when the customer asks for a person. Always tell the " +
      "customer you are doing this.",

    write: true,

    summarize: ({ reason, priority }) => ({
      action: "Escalate to a human agent",
      detail: `Create a ${priority}-priority ticket for a human to pick up`,
      reason,
      irreversible: false,
      warning: null,
    }),

    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Why this needs a human, with enough context that the agent " +
            "picking it up does not have to re-read the whole conversation.",
        },
        priority: {
          type: "string",
          description:
            "How urgent this is: low, normal, high, or urgent. Use 'urgent' " +
            "only for issues causing active harm to the customer.",
          enum: ESCALATION_PRIORITIES,
        },
      },
      required: ["reason", "priority"],
      additionalProperties: false,
    },

    handler: async ({ reason, priority }, ctx = {}) => {
      // `enum` is checked here rather than in validateArgs. Our validator is
      // deliberately small and does not handle enums; rather than grow it for
      // one case, the handler owns the check. Either place is fine - what
      // matters is that SOMETHING checks it.
      if (!ESCALATION_PRIORITIES.includes(priority)) {
        return toolError(
          "invalid_priority",
          `Priority must be one of: ${ESCALATION_PRIORITIES.join(", ")}.`,
          { received: priority }
        );
      }

      if (reason.trim().length < 10) {
        return toolError(
          "insufficient_reason",
          "Escalation reason must be at least 10 characters - the human " +
            "picking this up needs real context."
        );
      }

      const ticket = await repo.recordEscalation({
        reason: reason.trim(),
        priority,
        runId: ctx.runId,
      });

      return {
        success: true,
        escalationId: ticket.id,
        priority,
        message: `Escalated to a human agent as ${ticket.id} with ${priority} priority.`,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Schema -> provider format
// ---------------------------------------------------------------------------

/**
 * Convert our registry into the `tools` array the LLM API expects.
 *
 * We keep our own format and translate here rather than writing the provider's
 * format directly, so that switching providers is a change to this one function
 * instead of a rewrite of every tool.
 */
function getToolDefinitions() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    type: "function",
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check arguments against a tool's JSON schema before running it.
 *
 * A deliberately small validator - enough for our schemas, and readable. A
 * production system would use a library like Ajv; we are hand-rolling it so
 * the validation step stays visible rather than hidden behind a dependency.
 *
 * NEVER TRUST THESE ARGUMENTS. They were written by a language model. The
 * assignment says outright that malformed and out-of-range values are
 * EXPECTED, not exceptional.
 *
 * @returns {string[]} list of problems; empty array means valid
 */
function validateArgs(schema, args) {
  const problems = [];

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return ["Arguments must be a JSON object."];
  }

  for (const key of schema.required ?? []) {
    if (!(key in args)) problems.push(`Missing required field: ${key}`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in (schema.properties ?? {}))) {
        problems.push(`Unexpected field: ${key}`);
      }
    }
  }

  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in args)) continue;
    const value = args[key];

    const actual = Array.isArray(value) ? "array" : typeof value;
    const expected = spec.type === "integer" ? "number" : spec.type;

    if (expected && actual !== expected) {
      problems.push(`Field ${key} must be a ${spec.type}, got ${actual}.`);
      continue;
    }
    if (spec.type === "integer" && !Number.isInteger(value)) {
      problems.push(`Field ${key} must be a whole number.`);
    }
    if (typeof spec.minimum === "number" && value < spec.minimum) {
      problems.push(`Field ${key} must be at least ${spec.minimum}.`);
    }
    if (typeof spec.maximum === "number" && value > spec.maximum) {
      problems.push(`Field ${key} must be at most ${spec.maximum}.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model.
 *
 * This function NEVER throws. Every failure path returns a structured error
 * object instead, because the agent loop must survive a bad tool call and
 * reason about what went wrong.
 *
 * @param {string} name    tool name the model asked for
 * @param {string} rawArgs the model's arguments, as a JSON STRING
 * @returns {{ result: Object, ok: boolean, durationMs: number }}
 */
async function executeTool(name, rawArgs, ctx = {}) {
  const startedAt = Date.now();
  const done = (result, ok) => ({
    result,
    ok,
    durationMs: Date.now() - startedAt,
  });

  const tool = TOOLS[name];
  if (!tool) {
    // The model hallucinated a tool that does not exist. Rare, but it happens,
    // and it must not be fatal.
    return done(
      toolError(
        "unknown_tool",
        `No tool named "${name}". Available tools: ${Object.keys(TOOLS).join(", ")}.`
      ),
      false
    );
  }

  // The API hands us `arguments` as a STRING, not an object - and a model
  // wrote it, so it can be malformed JSON. This parse must never crash us.
  let args;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (err) {
    return done(
      toolError(
        "invalid_json",
        "Arguments were not valid JSON. Please re-send them as a valid JSON object.",
        { received: String(rawArgs).slice(0, 200) }
      ),
      false
    );
  }

  const problems = validateArgs(tool.parameters, args);
  if (problems.length > 0) {
    return done(
      toolError("invalid_arguments", problems.join(" "), { problems }),
      false
    );
  }

  // Even a validated call can fail at runtime - a database timeout, a bug in
  // our own handler. Catch it, so one broken tool cannot take down the loop.
  try {
    const result = await tool.handler(args, ctx);
    const ok = !(result && result.error);
    return done(result, ok);
  } catch (err) {
    console.error(`[tool:${name}] handler threw:`, err);
    return done(
      toolError("tool_execution_failed", `The ${name} tool failed unexpectedly.`),
      false
    );
  }
}

// ---------------------------------------------------------------------------
// Confirmation support
// ---------------------------------------------------------------------------

/** Does this tool have side effects, and therefore need confirming? */
function isWriteTool(name) {
  return Boolean(TOOLS[name]?.write);
}

/**
 * Describe what a tool call WOULD do, without doing it.
 *
 * Used to build the confirmation prompt. Runs the same validation as
 * executeTool, so an invalid call is caught before we bother a human with it -
 * there is no point asking someone to approve an action that would fail anyway.
 *
 * @returns {{ ok: boolean, summary?: Object, error?: Object }}
 */
function describeToolCall(name, rawArgs) {
  const tool = TOOLS[name];
  if (!tool) {
    return {
      ok: false,
      error: toolError("unknown_tool", `No tool named "${name}".`),
    };
  }

  let args;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (err) {
    return {
      ok: false,
      error: toolError("invalid_json", "Arguments were not valid JSON."),
    };
  }

  const problems = validateArgs(tool.parameters, args);
  if (problems.length > 0) {
    return {
      ok: false,
      error: toolError("invalid_arguments", problems.join(" "), { problems }),
    };
  }

  // Fall back to a generic description if a write tool has no summarize().
  // Better a dull confirmation than a crash - and the tool still gets gated.
  const summary = tool.summarize
    ? tool.summarize(args)
    : {
        action: name,
        detail: `Run ${name} with ${JSON.stringify(args)}`,
        irreversible: true,
        warning: "This tool has side effects.",
      };

  // ---- WHO IS ALLOWED TO APPROVE THIS? ---------------------------------
  //
  // Not every approval is the same kind of approval.
  //
  //   A customer can confirm their OWN small refund on a call. They are the
  //     one owed the money; "yes, refund my duplicate charge" is consent,
  //     not authorisation.
  //
  //   A customer cannot approve a LARGE refund. That is a supervisor
  //     decision, and asking the person who benefits from it to authorise it
  //     is not an approval at all - it is a formality with a microphone.
  //
  // This flag was READ by the voice session from the start and never SET by
  // anything, so every amount fell to "ask the caller" - including a 05
  // refund that should have gone to the operator queue.
  //
  // The threshold is the policy's own autoApproveMax, not a second number
  // invented here. One source of truth for what counts as large.
  const amount = typeof args.amount === "number" ? args.amount : null;
  if (amount !== null && (name === "issueRefund" || name === "applyAccountCredit")) {
    const limit =
      name === "issueRefund"
        ? LIMITS.refund.autoApproveMax
        : LIMITS.credit.autoApproveMax;
    summary.requiresOperator = amount > limit;
  }

  return { ok: true, summary, args };
}

module.exports = {
  TOOLS,
  getToolDefinitions,
  executeTool,
  validateArgs,
  toolError,
  isWriteTool,
  describeToolCall,
};
