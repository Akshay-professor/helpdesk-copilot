/**
 * test-policy-unit.js
 *
 * The safety limits, as pure functions. No LLM, no database, no API keys.
 *
 * WHY SEPARATE FROM test-safety.js
 *
 * test-safety.js drives the whole agent, which needs a model and a database
 * and fails when a free-tier quota resets. That makes it a good pre-demo check
 * and a terrible CI gate.
 *
 * But the thing it is really protecting - "code decides what is allowed, not
 * the prompt" - is a pure function. Those can run on every push, in a second,
 * with no credentials.
 *
 * If this file ever goes red, the single most important safety property in the
 * project has broken.
 *
 *   node test-policy-unit.js
 */

const { checkRefundAmount, checkCreditAmount, LIMITS, TIER } = require("./src/policy/policy");

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push({ label, actual, expected });
    console.log(`  FAIL  ${label}  (got ${actual}, wanted ${expected})`);
  }
}

console.log("=".repeat(70));
console.log("POLICY LIMITS - pure functions, no model involved");
console.log("=".repeat(70));

const R = LIMITS.refund;
const C = LIMITS.credit;

console.log("\nRefunds\n");
check("$0.01 auto-approves", checkRefundAmount(0.01).tier, TIER.ALLOW);
check(`$${R.autoApproveMax} (at the limit) auto-approves`, checkRefundAmount(R.autoApproveMax).tier, TIER.ALLOW);
check(`$${R.autoApproveMax + 0.01} needs approval`, checkRefundAmount(R.autoApproveMax + 0.01).tier, TIER.NEEDS_APPROVAL);
check(`$${R.approvalMax} (at the ceiling) needs approval`, checkRefundAmount(R.approvalMax).tier, TIER.NEEDS_APPROVAL);
check(`$${R.approvalMax + 0.01} is refused outright`, checkRefundAmount(R.approvalMax + 0.01).tier, TIER.REFUSE);

console.log("\nCredits\n");
check(`$${C.autoApproveMax} auto-approves`, checkCreditAmount(C.autoApproveMax).tier, TIER.ALLOW);
check(`$${C.autoApproveMax + 0.01} needs approval`, checkCreditAmount(C.autoApproveMax + 0.01).tier, TIER.NEEDS_APPROVAL);
check(`$${C.approvalMax + 0.01} is refused outright`, checkCreditAmount(C.approvalMax + 0.01).tier, TIER.REFUSE);

console.log("\nThe values a model actually produces\n");
console.log(
  "  A model writes arguments as JSON, so these are not hypothetical.\n" +
    "  NaN is the dangerous one: `NaN > 100` is FALSE, so a missing guard\n" +
    "  lets an unparseable amount fall through to ALLOW.\n"
);
check("NaN is refused", checkRefundAmount(NaN).tier, TIER.REFUSE);
check("Infinity is refused", checkRefundAmount(Infinity).tier, TIER.REFUSE);
check("a string is refused", checkRefundAmount("240").tier, TIER.REFUSE);
check("null is refused", checkRefundAmount(null).tier, TIER.REFUSE);
check("undefined is refused", checkRefundAmount(undefined).tier, TIER.REFUSE);
check("negative is refused", checkRefundAmount(-50).tier, TIER.REFUSE);
check("zero is refused", checkRefundAmount(0).tier, TIER.REFUSE);

console.log("\n" + "=".repeat(70));
console.log(`${pass} / ${pass + failures.length} passed`);
console.log("=".repeat(70));

if (failures.length > 0) {
  console.log(
    "\n  A failure here means the limits are no longer enforced in code.\n" +
      "  That is the one property this whole project is built around.\n"
  );
  process.exit(1);
}

console.log(
  "\n  Limits hold at every boundary, and every non-finite value a model\n" +
    "  can produce is refused rather than compared.\n"
);
