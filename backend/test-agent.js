/**
 * test-agent.js - scratch script for Step 3.
 *
 * Run with:  node test-agent.js
 *
 * Tests the agent loop directly, with no web server involved. Same principle
 * as test-llm.js: one layer at a time, so a failure has only one suspect.
 */

require("dotenv").config();
const { runAgent } = require("./src/agent/agentRunner");
const { executeTool } = require("./src/tools/toolRegistry");

function line(title) {
  console.log("\n" + "=".repeat(64));
  console.log(title);
  console.log("=".repeat(64));
}

async function main() {
  // --- Part 1: the tool alone, no LLM ------------------------------------
  line("PART 1  Tool tested directly (no LLM involved)");

  const cases = [
    ["valid", 'getCustomer', '{"email":"alice@shop.com"}'],
    ["unknown customer", "getCustomer", '{"email":"nobody@shop.com"}'],
    ["malformed JSON", "getCustomer", "{not json at all"],
    ["missing field", "getCustomer", "{}"],
    ["wrong type", "getCustomer", '{"email":123}'],
    ["extra field", "getCustomer", '{"email":"a@b.com","admin":true}'],
    ["tool that does not exist", "deleteEverything", "{}"],
  ];

  for (const [label, name, args] of cases) {
    const { result, ok, durationMs } = await executeTool(name, args);
    console.log(
      `\n  ${label}\n    ok=${ok} (${durationMs}ms)\n    ${JSON.stringify(result)}`
    );
  }

  // --- Part 2: the full loop ---------------------------------------------
  line("PART 2  Full agent loop - should call the tool");

  const r = await runAgent("Who is alice@shop.com? What tier are they on?");

  console.log("\nREPLY:\n  " + r.reply);
  console.log(`\nIterations: ${r.iterations}   Tokens: ${r.tokensUsed}`);
  console.log("\nTRACE:");
  for (const t of r.trace) {
    console.log(`\n  Iteration ${t.iteration}  (${t.durationMs}ms, ${t.tokens} tokens)`);
    if (t.content) console.log(`    said: ${t.content.slice(0, 100)}`);
    for (const c of t.toolCalls) {
      console.log(`    TOOL ${c.name}(${c.rawArguments})`);
      console.log(`      -> ok=${c.ok} ${JSON.stringify(c.result).slice(0, 120)}`);
    }
    if (t.toolCalls.length === 0 && !t.content) console.log("    (nothing)");
  }

  // --- Part 3: recovery from a tool error --------------------------------
  line("PART 3  Unknown customer - agent must recover, not crash");

  const r2 = await runAgent("Look up the account for ghost@nowhere.com");
  console.log("\nREPLY:\n  " + r2.reply);
  console.log(`\nIterations: ${r2.iterations}`);
  for (const t of r2.trace) {
    for (const c of t.toolCalls) {
      console.log(`  TOOL ${c.name} -> ok=${c.ok} ${JSON.stringify(c.result)}`);
    }
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
