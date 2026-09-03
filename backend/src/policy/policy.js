/**
 * policy.js
 *
 * Every safety limit in the system, in one file.
 *
 * WHY THIS IS A SEPARATE FILE:
 *
 * These numbers could live inside the tool handlers that use them. They do not,
 * for three reasons:
 *
 *   1. An auditor - or you, in six months - can read the entire safety posture
 *      of this system in under a minute, without reading any tool code.
 *   2. Changing a limit is a one-line change in a file whose whole purpose is
 *      limits. Nobody has to go hunting through handlers.
 *   3. The limits become testable on their own, independent of the tools.
 *
 * THE ORGANISING PRINCIPLE: REVERSIBILITY, NOT SIZE.
 *
 * The assignment's own gradient makes this explicit - a $10 credit is
 * autonomous because it is *mostly* reversible; a $2,400 refund needs approval
 * because the money has left and there is no undo; account deletion is never
 * autonomous at ANY value because the data is gone.
 *
 * That is why the credit ceiling ($50) sits ABOVE the refund ceiling ($100 for
 * a full auto-approve, but credit is recoverable from the balance while a
 * refund is not). Ask "can this be undone?" before "how much is it?".
 *
 * Full reasoning: docs/autonomy-policy.md
 */

// ---------------------------------------------------------------------------
// Autonomy tiers
// ---------------------------------------------------------------------------

/**
 * What the system is allowed to do with a proposed action.
 *
 * Build 1 implements ALLOW and REFUSE. NEEDS_APPROVAL is returned as a
 * structured refusal for now, because Build 1 has no approval queue - Build 2
 * turns it into a real pause-and-wait. The tier boundaries do not change
 * between builds; only what happens at the boundary does.
 */
const TIER = {
  ALLOW: "allow",
  NEEDS_APPROVAL: "needs_approval",
  REFUSE: "refuse",
};

// ---------------------------------------------------------------------------
// The limits
// ---------------------------------------------------------------------------

const LIMITS = {
  refund: {
    /** At or below this, the agent may act alone. */
    autoApproveMax: 100,
    /** Above autoApproveMax and up to here, a human must approve. */
    approvalMax: 2000,
    // Above approvalMax: refused outright. Approval is not sufficient; this
    // has to become a human-owned process, not a human-rubber-stamped one.
  },

  credit: {
    /** At or below this, the agent may act alone. */
    autoApproveMax: 50,
    /** Account credit is never autonomous above this - escalate instead. */
    approvalMax: 500,
  },

  /**
   * Actions the agent may never take, at any value, under any approval.
   * Nothing in Build 1 implements these yet; the list exists so that adding
   * such a tool later cannot accidentally default to "allowed".
   */
  neverAutonomous: [
    "deleteAccount",
    "changePaymentMethod",
    "exportCustomerData",
    "modifyLegalAgreement",
  ],
};

/** Valid priorities for escalateToHuman. */
const ESCALATION_PRIORITIES = ["low", "normal", "high", "urgent"];

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Decide what may happen with a proposed refund.
 *
 * Pure function: no side effects, no I/O. That is deliberate - it means this
 * can be unit-tested exhaustively without a database, an LLM, or a network.
 * Safety logic you cannot test cheaply is safety logic nobody tests.
 *
 * @param {number} amount
 * @returns {{ tier: string, reason: string, limit?: number }}
 */
function checkRefundAmount(amount) {
  // Guard the inputs before comparing them. `NaN > 100` is false, which would
  // silently ALLOW a garbage amount. Never let a bad value fall through to a
  // permissive branch.
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return { tier: TIER.REFUSE, reason: "Refund amount must be a finite number." };
  }
  if (amount <= 0) {
    return { tier: TIER.REFUSE, reason: "Refund amount must be greater than zero." };
  }

  if (amount > LIMITS.refund.approvalMax) {
    return {
      tier: TIER.REFUSE,
      reason:
        `Refunds above $${LIMITS.refund.approvalMax} cannot be processed through ` +
        `this system at all and must be handled by a manager directly.`,
      limit: LIMITS.refund.approvalMax,
    };
  }

  if (amount > LIMITS.refund.autoApproveMax) {
    return {
      tier: TIER.NEEDS_APPROVAL,
      reason:
        `Refunds above $${LIMITS.refund.autoApproveMax} require human approval ` +
        `before they can be issued.`,
      limit: LIMITS.refund.autoApproveMax,
    };
  }

  return { tier: TIER.ALLOW, reason: "Within the autonomous refund limit." };
}

/**
 * Decide what may happen with a proposed account credit.
 * @param {number} amount
 * @returns {{ tier: string, reason: string, limit?: number }}
 */
function checkCreditAmount(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return { tier: TIER.REFUSE, reason: "Credit amount must be a finite number." };
  }
  if (amount <= 0) {
    return { tier: TIER.REFUSE, reason: "Credit amount must be greater than zero." };
  }

  if (amount > LIMITS.credit.approvalMax) {
    return {
      tier: TIER.REFUSE,
      reason:
        `Account credits above $${LIMITS.credit.approvalMax} must be handled ` +
        `by a manager directly.`,
      limit: LIMITS.credit.approvalMax,
    };
  }

  if (amount > LIMITS.credit.autoApproveMax) {
    return {
      tier: TIER.NEEDS_APPROVAL,
      reason:
        `Account credits above $${LIMITS.credit.autoApproveMax} require human ` +
        `approval.`,
      limit: LIMITS.credit.autoApproveMax,
    };
  }

  return { tier: TIER.ALLOW, reason: "Within the autonomous credit limit." };
}

module.exports = {
  TIER,
  LIMITS,
  ESCALATION_PRIORITIES,
  checkRefundAmount,
  checkCreditAmount,
};
