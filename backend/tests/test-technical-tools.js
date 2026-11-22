/**
 * The Technical specialist's tools: getSystemStatus and lookupLogs.
 * Offline - runs against the seed fixtures, no LLM, no database.
 *
 *   node tests/test-technical-tools.js
 */
const assert = require("node:assert");
const { executeTool } = require("../src/tools/toolRegistry");
const { SPECIALISTS } = require("../src/agents/specialists");

const run = (name, args, ctx = {}) =>
  executeTool(name, JSON.stringify(args), ctx).then((r) => r.result);

(async () => {
  const all = await run("getSystemStatus", {});
  assert.equal(all.degradedCount, 2, "payments + shipping-tracking are degraded");

  const pay = await run("getSystemStatus", { component: "payments" });
  assert.equal(pay.components[0].status, "degraded");

  const bad = await run("getSystemStatus", { component: "mainframe" });
  assert.equal(bad.error, "invalid_arguments", "enum enforced before the handler");

  // The root cause of the seeded double charge is findable.
  const logs = await run("lookupLogs", { customerId: "cus_001", ref: "ord_1001" }, { callerId: "cus_001" });
  assert.equal(logs.count, 3);
  assert(logs.lines.some((l) => /timeout/.test(l.message)));

  const other = await run("lookupLogs", { customerId: "cus_002" }, { callerId: "cus_001" });
  assert.equal(other.error, "not_authorized", "another customer's logs are refused");

  const badService = await run("lookupLogs", { customerId: "cus_001", service: "nope" });
  assert.equal(badService.error, "invalid_arguments");

  // Isolation: the technical agent has them, billing does not.
  assert(SPECIALISTS.technical.tools.includes("lookupLogs"));
  assert(!SPECIALISTS.billing.tools.includes("lookupLogs"));
  assert(!SPECIALISTS.technical.tools.includes("issueRefund"), "still no money-moving tools");

  console.log("technical tools: all checks pass");
  process.exit(0);
})();
