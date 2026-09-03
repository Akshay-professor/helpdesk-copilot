/**
 * test-gaps.js
 *
 * When one specialist fails, does the NEXT one know what it does not know?
 *
 * The bug this guards against was real. The account specialist died on a 503,
 * billing ran anyway with no findings, and told the customer:
 *
 *   "The subscription itself was active at the time of the charge."
 *
 * Nobody established that. The specialist that was supposed to check it was
 * dead. Silence about a gap reads to a model as "nothing to worry about".
 */
require("dotenv").config();

const { buildBrief } = require("./src/agents/coordinator");
const { SPECIALISTS } = require("./src/agents/specialists");

let pass = 0, fail = 0;
const check = (l, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}`); ok ? pass++ : fail++; };

const msg = "My subscription didn't renew and I was charged anyway";

console.log("\nWith a GAP (the account specialist failed):\n");
const withGap = buildBrief(
  SPECIALISTS.billing,
  "Determine if the charge was legitimate",
  msg,
  [],
  ["Verify whether the subscription lapsed at the time of the charge"]
);
console.log(withGap.split("\n").map((l) => "    " + l).join("\n"));

check("the brief names the unanswered question", /lapsed/.test(withGap));
check("it says the investigation was incomplete", /could not be completed/i.test(withGap));
check("it forbids asserting anything about it", /Do not assert/i.test(withGap));

console.log("\nWith a FINDING (the account specialist succeeded):\n");
const withFinding = buildBrief(
  SPECIALISTS.billing,
  "Determine if the charge was legitimate",
  msg,
  [{ from: "account", answer: "The subscription lapsed on 12 March." }],
  []
);
check("no false 'incomplete' warning when nothing failed",
  !/could not be completed/i.test(withFinding));
check("the finding is present", /12 March/.test(withFinding));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
