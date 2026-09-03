/**
 * test-coordinator.js
 *
 * End-to-end through the coordinator, on the assignment's own hard example.
 */
require("dotenv").config();
const { connectDB } = require("./src/db/connection");
// Connect the KB too. Forgetting this made every policy question in an
// earlier benchmark run return "knowledge_base_unavailable" - the product
// was fine, the HARNESS was lying. A measurement that quietly degrades the
// thing it measures is worse than no measurement.
const { connectVectorStore } = require("./src/rag/vectorStore");
const { runCoordinator } = require("./src/agents/coordinator");

(async () => {
  await connectDB();
  await connectVectorStore();

  const cases = [
    ["single domain", "I'm alice@shop.com - where is my order ord_1001?"],
    [
      "two domains, dependent",
      "I'm alice@shop.com. My subscription didn't renew and I was charged anyway - what happened?",
    ],
  ];

  for (const [label, message] of cases) {
    console.log("\n" + "=".repeat(68));
    console.log(label.toUpperCase());
    console.log("=".repeat(68));
    console.log(`> ${message}\n`);

    const events = [];
    const t0 = Date.now();
    const r = await runCoordinator(message, {
      callerId: "cus_001",
      onEvent: (e) => {
        events.push(e);
        if (e.type === "coordinated")
          console.log(`  [coordinator] ${e.mode}: ${e.specialists.join(" -> ")} (${e.latencyMs}ms)`);
        if (e.type === "delegated")
          console.log(`  [delegate]    ${e.specialist} (${e.toolCount} tools): ${e.task}`);
        if (e.type === "tool_call")
          console.log(`      ${e.specialist ?? "?"} calls ${e.tool}`);
        if (e.type === "specialist_done")
          console.log(`  [done]        ${e.specialist}: ${e.status}, ${e.tokensUsed} tok, ${e.durationMs}ms`);
      },
    });

    console.log(`\n  REPLY: ${r.reply}`);
    console.log(
      `\n  status=${r.status} route=${r.route} tokens=${r.tokensUsed} ` +
        `wall=${Date.now() - t0}ms delegations=${r.multiAgent?.delegations}`
    );
    if (r.multiAgent?.perSpecialist)
      console.table(r.multiAgent.perSpecialist);
  }
  process.exit(0);
})();
