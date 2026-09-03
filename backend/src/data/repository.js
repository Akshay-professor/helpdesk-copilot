/**
 * repository.js
 *
 * The single place that knows HOW data is stored.
 *
 * Tools call these functions. They never touch Mongoose, and they never touch
 * the seed arrays. That indirection is the whole point:
 *
 *   - MongoDB up   -> these read and write the database
 *   - MongoDB down -> these fall back to the in-memory seed arrays
 *
 * The tools cannot tell the difference, so the agent keeps working either way.
 *
 * This is the boundary `seed.js` was created for back at Step 4. Swapping the
 * storage engine touched this one new file and the tool handlers' `async`
 * keywords — not a single line of agent loop code.
 *
 * WHY EVERYTHING HERE IS ASYNC:
 * Database calls take time, so they return Promises. Even the in-memory
 * fallback returns a Promise, so the tools have ONE shape to deal with rather
 * than "sometimes async, sometimes not". Mixing the two is how you end up with
 * a Promise where you expected a customer.
 */

const { isConnected } = require("../db/connection");
const { Customer, Order, Invoice, Refund, Escalation } = require("../db/models");
const seed = require("./seed");

/**
 * THE SILENT FALLBACK PROBLEM — read this before trusting `isConnected()`.
 *
 * The in-memory fallback below exists so the agent keeps working when MongoDB
 * is down. That is genuinely useful. It is also a trap, and we walked into it:
 *
 *   - MongoDB had Bob's credit at $30.50 (from an earlier run)
 *   - The seed array still said $15.50 (its hardcoded starting value)
 *   - A read issued BEFORE connectDB() resolved silently returned $15.50
 *   - A write issued after it landed on the $30.50 row
 *
 * The same query returned two different answers depending on timing, and
 * nothing warned us. A test failed with "wrong amount applied" when the real
 * problem was that half the calls were talking to a different data store.
 *
 * Two mitigations:
 *   1. `warnedFallback` below logs LOUDLY the first time a fallback read
 *      happens, so a silent divergence becomes a visible one.
 *   2. Callers must await connectDB() before doing any work. Every entry point
 *      (server startup, each test file) now does.
 *
 * The deeper lesson: a fallback that silently returns DIFFERENT data is worse
 * than no fallback. A fallback should degrade capability, never truthfulness.
 */
let warnedFallback = false;

function usingFallback(operation) {
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      `[repo] MongoDB unavailable - falling back to in-memory seed data ` +
        `(first hit: ${operation}). Data will NOT persist and may differ ` +
        `from what is in the database.`
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function findCustomerByEmail(email) {
  const needle = email.trim().toLowerCase();

  if (isConnected()) {
    // .lean() returns a plain object instead of a Mongoose document. Faster,
    // and the tools only ever read these - they do not need change tracking.
    return Customer.findOne({ email: needle }).lean();
  }

  usingFallback("findCustomerByEmail");
  return seed.CUSTOMERS.find((c) => c.email.toLowerCase() === needle) ?? null;
}

async function findCustomerById(customerId) {
  if (isConnected()) return Customer.findOne({ id: customerId }).lean();
  usingFallback("findCustomerById");
  return seed.CUSTOMERS.find((c) => c.id === customerId) ?? null;
}

async function findOrdersByCustomer(customerId, limit = 10) {
  if (isConnected()) {
    return Order.find({ customerId }).sort({ placedAt: -1 }).limit(limit).lean();
  }
  usingFallback("findOrdersByCustomer");
  return seed.ORDERS.filter((o) => o.customerId === customerId)
    .sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt))
    .slice(0, limit);
}

async function findOrderById(orderId) {
  if (isConnected()) return Order.findOne({ id: orderId }).lean();
  usingFallback("findOrderById");
  return seed.ORDERS.find((o) => o.id === orderId) ?? null;
}

async function findInvoicesByCustomer(customerId) {
  if (isConnected()) {
    return Invoice.find({ customerId }).sort({ issuedAt: -1 }).lean();
  }
  usingFallback("findInvoicesByCustomer");
  return seed.INVOICES.filter((i) => i.customerId === customerId).sort(
    (a, b) => new Date(b.issuedAt) - new Date(a.issuedAt)
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record a refund and increase the order's refunded total.
 *
 * NOTE ON ATOMICITY: these are two separate writes. If the process died
 * between them we would have an order marked refunded with no refund record,
 * or vice versa. MongoDB transactions would fix that, but they require a
 * replica set, which our single-container dev setup does not have.
 *
 * The order below is deliberate: bump the order FIRST. If we crash after that,
 * we have charged the customer's refund allowance without a receipt - annoying,
 * and visible in an audit. The other order would let a second refund through
 * for money already sent, which is worse.
 *
 * When in doubt, fail toward not paying out twice.
 */
async function recordRefund({ orderId, customerId, amount, reason, runId }) {
  if (isConnected()) {
    const order = await Order.findOneAndUpdate(
      { id: orderId },
      { $inc: { refundedAmount: amount } },
      { returnDocument: 'after' }
    ).lean();

    const count = await Refund.countDocuments();
    const refund = {
      id: `ref_${String(count + 1).padStart(4, "0")}`,
      orderId,
      customerId,
      amount,
      reason,
      issuedAt: new Date().toISOString(),
      runId,
    };
    await Refund.create(refund);

    return { refund, order };
  }

  usingFallback("recordRefund");
  const order = seed.ORDERS.find((o) => o.id === orderId);
  order.refundedAmount = Number((order.refundedAmount + amount).toFixed(2));

  const refund = {
    id: `ref_${String(seed.REFUNDS.length + 1).padStart(4, "0")}`,
    orderId,
    customerId,
    amount,
    reason,
    issuedAt: new Date().toISOString(),
    runId,
  };
  seed.REFUNDS.push(refund);

  return { refund, order };
}

async function applyCredit({ customerId, amount }) {
  if (isConnected()) {
    return Customer.findOneAndUpdate(
      { id: customerId },
      { $inc: { accountCredit: amount } },
      { returnDocument: 'after' }
    ).lean();
  }

  usingFallback("applyCredit");
  const customer = seed.CUSTOMERS.find((c) => c.id === customerId);
  customer.accountCredit = Number((customer.accountCredit + amount).toFixed(2));
  return customer;
}

/**
 * Change a customer's tier. Build 3's ACCOUNT action.
 *
 * Added because Build 3 revealed a real gap: every write tool we had moved
 * money, so "the billing agent cannot touch account tools" was a claim we
 * could not demonstrate - there were no account tools to withhold.
 *
 * Returns the customer with both the old and new tier, because a tool result
 * that only says "gold" cannot tell the model whether anything changed.
 */
async function changeTier({ customerId, tier }) {
  if (isConnected()) {
    const before = await Customer.findOne({ id: customerId }).lean();
    if (!before) return null;

    const after = await Customer.findOneAndUpdate(
      { id: customerId },
      { $set: { tier } },
      { returnDocument: "after" }
    ).lean();

    return { ...after, previousTier: before.tier };
  }

  usingFallback("changeTier");
  const customer = seed.CUSTOMERS.find((c) => c.id === customerId);
  if (!customer) return null;
  const previousTier = customer.tier;
  customer.tier = tier;
  return { ...customer, previousTier };
}

async function recordEscalation({ reason, priority, runId }) {
  if (isConnected()) {
    const count = await Escalation.countDocuments();
    const ticket = {
      id: `esc_${String(count + 1).padStart(4, "0")}`,
      reason,
      priority,
      status: "open",
      createdAt: new Date().toISOString(),
      runId,
    };
    await Escalation.create(ticket);
    return ticket;
  }

  const ticket = {
    id: `esc_${String(seed.ESCALATIONS.length + 1).padStart(4, "0")}`,
    reason,
    priority,
    status: "open",
    createdAt: new Date().toISOString(),
    runId,
  };
  seed.ESCALATIONS.push(ticket);
  return ticket;
}

module.exports = {
  findCustomerByEmail,
  findCustomerById,
  findOrdersByCustomer,
  findOrderById,
  findInvoicesByCustomer,
  recordRefund,
  applyCredit,
  changeTier,
  recordEscalation,
};
