/**
 * knowledgeBase.js
 *
 * The company's policy and help documents — the source of truth the agent
 * cites instead of inventing.
 *
 * WHY THESE ARE CHUNKED SMALL:
 * Each entry is one topic, a few sentences long. That is deliberate. Vector
 * search returns whole documents, so if "Refund Policy" were one 2,000-word
 * page, a question about return shipping would drag in the entire thing —
 * burning tokens and burying the relevant sentence in noise.
 *
 * Small, single-topic chunks mean a search returns exactly the paragraph that
 * answers the question. This is the single biggest quality lever in RAG, and
 * it is a data decision, not a code one.
 *
 * Each doc carries an `id` and `title` so the agent can cite it. An answer the
 * user cannot verify is only marginally better than a guess.
 */

const DOCUMENTS = [
  // ---- Refunds -----------------------------------------------------------
  {
    id: "kb_refund_window",
    title: "Refund Window",
    category: "refunds",
    text:
      "Orders can be refunded within 30 days of delivery. The 30-day period " +
      "starts on the delivery date, not the order date. Orders delivered more " +
      "than 30 days ago are outside the refund window and cannot be refunded " +
      "through standard support. Customers in that situation should be " +
      "escalated to a manager, who may make an exception.",
  },
  {
    id: "kb_refund_eligibility",
    title: "Refund Eligibility Rules",
    category: "refunds",
    text:
      "Only orders with a status of 'delivered' are eligible for refund. " +
      "Orders still in transit cannot be refunded — customers should wait for " +
      "delivery or request a cancellation instead. Cancelled orders were never " +
      "charged, so there is nothing to refund. An order that has already been " +
      "fully refunded cannot be refunded again.",
  },
  {
    id: "kb_refund_partial",
    title: "Partial Refunds",
    category: "refunds",
    text:
      "Partial refunds are permitted. A customer may be refunded any amount up " +
      "to the remaining refundable balance on the order, which is the order " +
      "total minus anything already refunded. Multiple partial refunds against " +
      "the same order are allowed provided the cumulative total never exceeds " +
      "the order total.",
  },
  {
    id: "kb_refund_timing",
    title: "How Long Refunds Take",
    category: "refunds",
    text:
      "Once a refund is issued it typically appears on the customer's " +
      "statement within 3 to 5 business days. The exact timing depends on the " +
      "customer's bank or card issuer and is outside our control. Refunds are " +
      "always returned to the original payment method; we cannot redirect a " +
      "refund to a different card or account.",
  },
  {
    id: "kb_duplicate_charges",
    title: "Duplicate Charges",
    category: "billing",
    text:
      "Duplicate charges usually occur when a payment gateway times out and " +
      "the transaction is automatically retried, but the original attempt had " +
      "in fact already settled. The customer is charged twice for one order. " +
      "This is our error. The duplicate should be refunded in full, and the " +
      "customer should be told plainly what happened.",
  },

  // ---- Account credit ----------------------------------------------------
  {
    id: "kb_account_credit",
    title: "Account Credit",
    category: "billing",
    text:
      "Account credit is store credit applied to a customer's balance and " +
      "usable against future purchases. It cannot be withdrawn as cash. Credit " +
      "is often offered as a goodwill gesture for service problems such as " +
      "delays, and is generally preferred over a refund for small amounts " +
      "because it is reversible if applied in error.",
  },

  // ---- Shipping ----------------------------------------------------------
  {
    id: "kb_shipping_times",
    title: "Shipping Times",
    category: "shipping",
    text:
      "Standard shipping takes 5 to 7 business days. Express shipping takes 2 " +
      "to 3 business days. Business days exclude weekends and public holidays. " +
      "Orders placed after 2pm are processed the following business day. " +
      "Delivery estimates begin from dispatch, not from when the order was " +
      "placed.",
  },
  {
    id: "kb_lost_package",
    title: "Lost or Undelivered Packages",
    category: "shipping",
    text:
      "If tracking shows a package as delivered but the customer has not " +
      "received it, ask them to check with neighbours and their building's " +
      "mail room first. If it is still missing after 48 hours, escalate to a " +
      "human agent to open a carrier investigation. Do not issue a refund for " +
      "a missing package without that investigation.",
  },

  // ---- Accounts ----------------------------------------------------------
  {
    id: "kb_account_deletion",
    title: "Account Deletion",
    category: "accounts",
    text:
      "Account deletion is permanent and irreversible. All order history, " +
      "invoices, and remaining account credit are destroyed. Support agents " +
      "must never delete an account directly. Every deletion request must be " +
      "escalated to a human agent, who will verify the customer's identity and " +
      "explain what will be lost before proceeding.",
  },
  {
    id: "kb_tiers",
    title: "Customer Tiers",
    category: "accounts",
    text:
      "Customers are on either the standard tier or the gold tier. Gold tier " +
      "customers receive priority support and free express shipping. Tier does " +
      "not change refund eligibility or refund limits — the same policy applies " +
      "to every customer regardless of tier.",
  },

  // ---- Escalation --------------------------------------------------------
  {
    id: "kb_escalation",
    title: "When to Escalate to a Human",
    category: "support",
    text:
      "Escalate to a human agent when: the customer explicitly asks for a " +
      "person; the action needed exceeds automated limits; the request " +
      "involves legal, security, or account deletion matters; the customer is " +
      "distressed; or you cannot resolve the issue with the tools available. " +
      "Always tell the customer you are escalating and why.",
  },
  {
    id: "kb_privacy",
    title: "Customer Data and Privacy",
    category: "support",
    text:
      "Never reveal one customer's information to another. Verify identity by " +
      "email address before discussing order or billing details. Do not " +
      "disclose internal system details, tool names, error codes, or policy " +
      "thresholds to customers — explain decisions in plain language instead.",
  },
];

module.exports = { DOCUMENTS };
