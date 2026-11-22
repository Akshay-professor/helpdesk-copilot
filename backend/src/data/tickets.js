/**
 * Past support tickets - the research agent's "ticket history" source.
 *
 * Indexed into their own ChromaDB collection by index-kb.js and searched by
 * meaning (sources.js -> searchTickets). The support agent never sees these:
 * a ticket is one customer's account of events, not policy.
 *
 * WHAT THIS SOURCE CAN AND CANNOT SUPPORT
 *
 * Tickets say WHY a customer was unhappy. They cannot give a churn RATE: only
 * unhappy customers write in, so counting cancellation tickets measures who
 * complained, not who left. The research agent has to say exactly that rather
 * than turn "5 of 16 tickets mention cancelling" into "31% churn".
 *
 * ponytail: static fixtures; load from the ticketing system (Zendesk export,
 * a Mongo collection) once there is one.
 */

const TICKETS = [
  // ---- Q3 2026 ------------------------------------------------------------
  { id: "tkt_0101", quarter: "2026-Q3", plan: "pro", category: "billing", outcome: "resolved", subject: "Annual renewal price jump", text: "Customer on the Pro plan surprised by the renewal price. Explained the annual pricing. Customer stayed after a one-off goodwill credit." },
  { id: "tkt_0102", quarter: "2026-Q3", plan: "standard", category: "shipping", outcome: "resolved", subject: "Security key not delivered", text: "Hardware security key delayed at the carrier. Arrived on day 9, inside the delivery window." },
  { id: "tkt_0103", quarter: "2026-Q3", plan: "pro", category: "technical", outcome: "resolved", subject: "SSO login loop", text: "Pro customer stuck in a sign-in loop after enabling SSO. Fixed by clearing the session; bug filed." },
  { id: "tkt_0104", quarter: "2026-Q3", plan: "pro", category: "account", outcome: "cancelled", subject: "Cancelling - moving to a competitor", text: "Pro customer cancelled. Reason given: a competitor offers the same features at a lower price for small teams." },
  { id: "tkt_0105", quarter: "2026-Q3", plan: "standard", category: "billing", outcome: "resolved", subject: "Invoice address change", text: "Customer needed a different billing address on invoices. Updated." },
  { id: "tkt_0106", quarter: "2026-Q3", plan: "pro", category: "technical", outcome: "resolved", subject: "Export to CSV missing columns", text: "Pro customer reported missing columns in CSV export. Known bug, workaround given." },

  // ---- Q4 2026 ------------------------------------------------------------
  { id: "tkt_0201", quarter: "2026-Q4", plan: "pro", category: "billing", outcome: "cancelled", subject: "Charged twice for Pro renewal - cancelling", text: "Pro customer charged twice for the annual renewal during the payment gateway incident. Refund issued, but the customer cancelled, citing loss of trust in billing." },
  { id: "tkt_0202", quarter: "2026-Q4", plan: "pro", category: "billing", outcome: "resolved", subject: "Duplicate charge on renewal", text: "Pro customer double-charged during the gateway timeout incident. Duplicate refunded within the day. Customer stayed." },
  { id: "tkt_0203", quarter: "2026-Q4", plan: "pro", category: "account", outcome: "cancelled", subject: "Subscription did not renew but was charged", text: "Pro customer's subscription showed as lapsed while the card was charged. Account fixed, but the customer chose not to continue." },
  { id: "tkt_0204", quarter: "2026-Q4", plan: "standard", category: "shipping", outcome: "resolved", subject: "Tracking not updating", text: "Tracking frozen for 48 hours due to the carrier delay. Package arrived." },
  { id: "tkt_0205", quarter: "2026-Q4", plan: "pro", category: "account", outcome: "cancelled", subject: "Too expensive for a two-person team", text: "Pro customer downgraded then cancelled: price too high for a team of two." },
  { id: "tkt_0206", quarter: "2026-Q4", plan: "pro", category: "technical", outcome: "resolved", subject: "Slow dashboard", text: "Pro customer reported slow dashboard loads. Resolved by a performance fix in the next release." },
  { id: "tkt_0207", quarter: "2026-Q4", plan: "standard", category: "account", outcome: "resolved", subject: "Locked out after failed logins", text: "Account locked for 15 minutes after three failed sign-ins. Explained the lockout policy." },
  { id: "tkt_0208", quarter: "2026-Q4", plan: "pro", category: "billing", outcome: "resolved", subject: "Wants a refund for unused seats", text: "Pro customer asked for a refund for unused seat licences. Partial refund within policy." },
  { id: "tkt_0209", quarter: "2026-Q4", plan: "standard", category: "billing", outcome: "resolved", subject: "Workshop seat cancelled", text: "Training workshop seat cancelled; customer asked when the money returns. Explained 5-10 business days." },
  { id: "tkt_0210", quarter: "2026-Q4", plan: "pro", category: "technical", outcome: "resolved", subject: "API rate limit errors", text: "Pro customer hitting API rate limits. Explained limits and batching." },
];

module.exports = { TICKETS };
