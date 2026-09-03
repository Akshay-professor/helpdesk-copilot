/**
 * authorization.js
 *
 * "Is this caller allowed to see this record?"
 *
 * ---------------------------------------------------------------------------
 * THE BUG THAT CREATED THIS FILE
 * ---------------------------------------------------------------------------
 *
 * A user typed "My name is Alice". There is exactly one Alice in the database,
 * so the model guessed alice@shop.com, the guess landed, and it disclosed her
 * complete order history - dates, products, order IDs - to a stranger who had
 * typed a first name.
 *
 * Challenged, the agent apologised and promised to ask for a full name next
 * time. That is a PROMPT-level correction to a DATA-ACCESS problem, and this
 * project has watched that pattern fail three times already.
 *
 * ---------------------------------------------------------------------------
 * THE BADGE AND THE GUARD
 * ---------------------------------------------------------------------------
 *
 * `ctx` is a VISITOR BADGE. It says who is asking:
 *
 *     ctx = { runId: "abc-123", callerId: "cus_001" }
 *
 * A badge opens no doors. It stops nobody. It only states a fact.
 *
 * The functions in this file are the SECURITY GUARD. They read the badge and
 * decide. Remove the guard and the badge is decoration - you would walk
 * straight past wearing it.
 *
 * That distinction is the whole point. You could thread `callerId` through
 * every tool in the system and change nothing, if no tool ever compares it.
 * Carrying a fact is not the same as enforcing it - exactly as a system prompt
 * saying "never refund over $500" changes nothing without `if (amount > 500)`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * This is AUTHORIZATION (what may this caller reach?), not AUTHENTICATION
 * (is this caller who they claim?). Today `callerId` arrives in a header, which
 * anyone could forge - so this is not yet a security boundary against a
 * determined attacker.
 *
 * It IS a real boundary against the failure we actually saw: an agent guessing
 * an identity and being believed. The model can now guess as confidently as it
 * likes; `if (ownerId !== ctx.callerId)` does not read the conversation.
 *
 * A login system later replaces the header with a verified session. Nothing in
 * this file changes when that happens - the guard already stands, it simply
 * starts reading a badge that cannot be forged.
 */

/**
 * Structured refusal.
 *
 * Deliberately identical in shape to every other tool error, so the agent
 * reasons about it rather than crashing - and deliberately vague about WHY.
 * "You may only access your own account" tells an attacker nothing; "customer
 * cus_003 belongs to someone else" confirms cus_003 exists.
 */
function notAuthorized(what = "this record") {
  return {
    error: "not_authorized",
    message:
      `You may only access your own account information. Ask the customer to ` +
      `confirm the email address on their account, and do not guess it.`,
    details: { attempted: what },
  };
}

/**
 * Is the caller identified at all?
 *
 * When no callerId is present we ALLOW. That is a deliberate, temporary
 * decision worth stating plainly rather than hiding:
 *
 *   - Build 1 has no login, and the test scripts call tools directly
 *   - Failing closed would break every existing test for no security gain,
 *     since the header is forgeable anyway
 *
 * The moment real authentication exists this must flip to deny-by-default.
 * Flagged here so it is a decision someone revisits, not one they inherit.
 */
function isAnonymous(ctx) {
  return !ctx || !ctx.callerId;
}

/**
 * May this caller act on records owned by `ownerId`?
 *
 * @param {Object} ctx     the badge - { callerId, ... }
 * @param {string} ownerId who the record belongs to
 * @returns {boolean}
 */
function ownsRecord(ctx, ownerId) {
  if (isAnonymous(ctx)) return true; // see isAnonymous - temporary
  return ctx.callerId === ownerId;
}

/**
 * The guard, as tools use it.
 *
 * Returns an error object to return straight back, or `null` to proceed.
 * Shaped this way so a handler reads as one line:
 *
 *     const denied = requireOwnership(ctx, customer.id);
 *     if (denied) return denied;
 */
function requireOwnership(ctx, ownerId, what) {
  return ownsRecord(ctx, ownerId) ? null : notAuthorized(what);
}

module.exports = { requireOwnership, ownsRecord, isAnonymous, notAuthorized };
