/**
 * An out-of-policy write is refused BEFORE the approval pause, so it never
 * reaches the confirm modal or the operator queue. Offline, no LLM.
 *
 *   node tests/test-refuse-before-pause.js
 */
const assert = require("node:assert");
const { describeToolCall } = require("../src/tools/toolRegistry");
const d = (name, args) => describeToolCall(name, JSON.stringify(args));

assert.equal(d("issueRefund", { orderId: "ord_1001", amount: 5000, reason: "x" }).error.error, "policy_violation");
assert.equal(d("applyAccountCredit", { customerId: "cus_001", amount: 900 }).ok, false, "credit over the ceiling never pauses");

const big = d("issueRefund", { orderId: "ord_1001", amount: 240, reason: "dup" });
assert(big.ok && big.summary.requiresOperator, "$240 pauses for an operator");
const small = d("issueRefund", { orderId: "ord_1001", amount: 55, reason: "dup" });
assert(small.ok && !small.summary.requiresOperator, "$55 pauses for the customer");

console.log("refuse-before-pause: all checks pass");
process.exit(0);
