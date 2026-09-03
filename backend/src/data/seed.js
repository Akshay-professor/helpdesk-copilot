/**
 * seed.js
 *
 * Fake data standing in for MongoDB.
 *
 * WHY THIS FILE EXISTS SEPARATELY:
 * The tools should not care where data comes from. Today it is these arrays;
 * at Step 7 it becomes MongoDB queries. If the tools read from this module
 * instead of from inline constants, that swap touches one file - and the agent
 * loop never notices at all.
 *
 * Same principle as llmClient.js being the only file that knows about Mistral:
 * put a boundary around the thing that will change.
 *
 * THE DATES ARE COMPUTED, NOT HARDCODED.
 * Refund eligibility depends on how long ago an order was delivered. If we
 * hardcoded "2025-03-14", every eligibility test would silently start failing
 * once that date drifted outside the policy window. Computing offsets from
 * today keeps the fixtures meaningful forever.
 */

/** Return an ISO date string N days before now. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const CUSTOMERS = [
  {
    id: "cus_001",
    email: "alice@shop.com",
    name: "Alice Martin",
    tier: "gold",
    accountCredit: 0,
    joinedAt: "2023-04-11",
  },
  {
    id: "cus_002",
    email: "bob@shop.com",
    name: "Bob Chen",
    tier: "standard",
    accountCredit: 15.5,
    joinedAt: "2024-09-02",
  },
  {
    id: "cus_003",
    email: "carol@shop.com",
    name: "Carol Nwosu",
    tier: "standard",
    accountCredit: 0,
    joinedAt: "2025-01-20",
  },
];

// ---------------------------------------------------------------------------
// Orders
//
// Deliberately spread across the eligibility boundaries so every branch of
// checkRefundEligibility can actually be exercised:
//   - delivered recently        -> eligible
//   - delivered long ago        -> outside the refund window
//   - already refunded          -> not eligible again
//   - still in transit          -> not yet eligible
//   - cancelled                 -> nothing to refund
// ---------------------------------------------------------------------------

const ORDERS = [
  // Alice: the duplicate-charge case (the assignment's worked example)
  {
    id: "ord_1001",
    customerId: "cus_001",
    description: "Pro Plan - Annual Subscription",
    total: 240.0,
    status: "delivered",
    placedAt: daysAgo(14),
    deliveredAt: daysAgo(12),
    refundedAmount: 0,
  },
  // Alice: an older order, outside the refund window
  {
    id: "ord_1002",
    customerId: "cus_001",
    description: "Onboarding Support Package",
    total: 150.0,
    status: "delivered",
    placedAt: daysAgo(120),
    deliveredAt: daysAgo(115),
    refundedAmount: 0,
  },
  // Alice: already fully refunded
  {
    id: "ord_1003",
    customerId: "cus_001",
    description: "Extra Seat Licence",
    total: 45.0,
    status: "delivered",
    placedAt: daysAgo(30),
    deliveredAt: daysAgo(27),
    refundedAmount: 45.0,
  },
  // Bob: still in transit
  {
    id: "ord_2001",
    customerId: "cus_002",
    description: "Hardware Security Key",
    total: 65.0,
    status: "shipped",
    placedAt: daysAgo(3),
    deliveredAt: null,
    refundedAmount: 0,
  },
  // Bob: cancelled before shipping
  {
    id: "ord_2002",
    customerId: "cus_002",
    description: "Training Workshop Seat",
    total: 300.0,
    status: "cancelled",
    placedAt: daysAgo(20),
    deliveredAt: null,
    refundedAmount: 0,
  },
  // Carol: a large delivered order - used to exercise the approval threshold
  // once issueRefund exists at Step 5
  {
    id: "ord_3001",
    customerId: "cus_003",
    description: "Enterprise Migration Service",
    total: 2400.0,
    status: "delivered",
    placedAt: daysAgo(9),
    deliveredAt: daysAgo(6),
    refundedAmount: 0,
  },
];

// ---------------------------------------------------------------------------
// Invoices
//
// THE DUPLICATE CHARGE.
// inv_5002 and inv_5003 are the same order, the same amount, on the same day.
// This is what makes the assignment's canonical request answerable:
//
//   "My last invoice charged me twice - please refund the duplicate and
//    tell me why it happened."
//
// The root cause is recorded in `note` on the duplicate, so the agent can
// explain WHY rather than only detecting THAT.
// ---------------------------------------------------------------------------

const INVOICES = [
  {
    id: "inv_5001",
    customerId: "cus_001",
    orderId: "ord_1002",
    amount: 150.0,
    status: "paid",
    issuedAt: daysAgo(120),
    note: null,
  },
  {
    id: "inv_5002",
    customerId: "cus_001",
    orderId: "ord_1001",
    amount: 240.0,
    status: "paid",
    issuedAt: daysAgo(14),
    note: null,
  },
  {
    id: "inv_5003",
    customerId: "cus_001",
    orderId: "ord_1001",
    amount: 240.0,
    status: "paid",
    issuedAt: daysAgo(14),
    note:
      "Duplicate charge. Payment gateway returned a timeout on the first " +
      "attempt and the retry succeeded, but the original had already settled.",
  },
  {
    id: "inv_5004",
    customerId: "cus_002",
    orderId: "ord_2001",
    amount: 65.0,
    status: "paid",
    issuedAt: daysAgo(3),
    note: null,
  },
  {
    id: "inv_5005",
    customerId: "cus_003",
    orderId: "ord_3001",
    amount: 2400.0,
    status: "paid",
    issuedAt: daysAgo(9),
    note: null,
  },
];

// ---------------------------------------------------------------------------
// Refund policy
//
// These are the rules checkRefundEligibility applies. They live as DATA rather
// than as `if` statements buried in the handler so the tool can cite which rule
// it applied - the agent then explains a decision instead of just reporting it.
// ---------------------------------------------------------------------------

const REFUND_POLICY = {
  windowDays: 30,
  eligibleStatuses: ["delivered"],
};

// ---------------------------------------------------------------------------
// Write-tool records
//
// Start empty and fill up as the agent acts. These are what make write tools
// genuinely stateful rather than pretend: issueRefund appends here AND mutates
// the order's refundedAmount, so a second refund attempt on the same order
// sees the first one and behaves correctly.
//
// At Step 7 these become MongoDB collections. The tools do not change.
// ---------------------------------------------------------------------------

/** @type {Array<{id:string, orderId:string, customerId:string, amount:number, reason:string, issuedAt:string}>} */
const REFUNDS = [];

/** @type {Array<{id:string, reason:string, priority:string, createdAt:string, status:string}>} */
const ESCALATIONS = [];

module.exports = {
  CUSTOMERS,
  ORDERS,
  INVOICES,
  REFUND_POLICY,
  REFUNDS,
  ESCALATIONS,
  daysAgo,
};
