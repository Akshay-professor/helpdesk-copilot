/**
 * test-stream.js — Step 8 verification.
 *
 * Run with:  node test-stream.js       (server must NOT already be running)
 *
 * Streaming is the one feature you cannot verify from a final result — the
 * whole point is WHEN things arrive, not what. So this test stamps every event
 * with the milliseconds since the request started. If those numbers all cluster
 * at the end, we built a slow /chat with extra steps.
 */

require("dotenv").config();
const { connectDB, disconnectDB } = require("./src/db/connection");
const { runAgent, resumeAgent } = require("./src/agent/agentRunner");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

async function watch(label, message) {
  line(label);
  console.log(`Q: ${message}\n`);

  const t0 = Date.now();
  const events = [];

  const result = await runAgent(message, {
    onEvent: (e) => {
      const ms = Date.now() - t0;
      events.push({ ...e, ms });

      const at = `${String(ms).padStart(6)}ms`;
      switch (e.type) {
        case "thinking":
          console.log(`  ${at}  thinking      ${e.message}`);
          break;
        case "tool_call":
          console.log(`  ${at}  tool_call     ${e.tool}(${JSON.stringify(e.args)})`);
          break;
        case "tool_result":
          console.log(`  ${at}  tool_result   ${e.tool} -> ${e.summary} (${e.durationMs}ms)`);
          break;
        case "token":
          console.log(`  ${at}  token         "${e.text.slice(0, 60).replace(/\n/g, " ")}..."`);
          break;
        case "awaiting_confirmation":
          console.log(`  ${at}  CONFIRM       ${e.summary.action}: ${e.summary.detail}`);
          break;
        case "done":
          console.log(
            `  ${at}  done          ${e.status}, ${e.iterations} iters, ` +
            `${e.tokensUsed} tokens, tools: [${e.toolsCalled.join(", ")}]`
          );
          break;
        default:
          console.log(`  ${at}  ${e.type}`);
      }
    },
  });

  return { result, events, total: Date.now() - t0 };
}

async function main() {
  await connectDB();

  // =====================================================================
  const a = await watch(
    "A.  MULTI-TOOL RUN — watch the activity arrive",
    "I'm alice@shop.com - what orders do I have, and am I eligible to refund the Pro Plan one?"
  );

  // The real assertion. If the first event lands near the end, nothing streamed.
  const first = a.events[0]?.ms ?? 0;
  const last = a.events[a.events.length - 1]?.ms ?? 0;
  const spread = last - first;

  console.log(`\n  first event : ${first}ms`);
  console.log(`  last event  : ${last}ms`);
  console.log(`  spread      : ${spread}ms over ${a.events.length} events`);
  console.log(
    `\n  ${first < last * 0.5 && spread > 500
      ? "PASS — events arrived progressively, not all at the end."
      : "FAIL — events bunched together; this is not really streaming."}`
  );

  // =====================================================================
  const b = await watch(
    "B.  WRITE TOOL — the stream must announce the confirmation",
    "I'm alice@shop.com. Please refund $30 on order ord_1001 for the duplicate charge."
  );

  const sawConfirm = b.events.some((e) => e.type === "awaiting_confirmation");
  const sawToolResultForWrite = b.events.some(
    (e) => e.type === "tool_result" && e.tool === "issueRefund"
  );

  console.log(`\n  emitted awaiting_confirmation : ${sawConfirm}`);
  console.log(`  emitted tool_result for refund : ${sawToolResultForWrite} (must be false)`);
  console.log(
    `\n  ${sawConfirm && !sawToolResultForWrite
      ? "PASS — the pause is visible, and nothing executed."
      : "FAIL"}`
  );

  // =====================================================================
  line("C.  RESUME ALSO STREAMS");

  if (b.result.status === "awaiting_confirmation") {
    const t0 = Date.now();
    const seen = [];
    const resumed = await resumeAgent(b.result, true, {
      onEvent: (e) => {
        seen.push(e.type);
        console.log(`  ${String(Date.now() - t0).padStart(6)}ms  ${e.type}`);
      },
    });
    console.log(`\n  status: ${resumed.status}`);
    console.log(
      `  ${seen.includes("done") ? "PASS — resume emits events too." : "FAIL"}`
    );
  }

  // =====================================================================
  line("D.  EVENT TYPES THE ASSIGNMENT ASKS FOR");

  const allTypes = new Set([
    ...a.events.map((e) => e.type),
    ...b.events.map((e) => e.type),
  ]);
  const required = ["thinking", "tool_call", "tool_result", "token", "done"];

  required.forEach((t) =>
    console.log(`  ${allTypes.has(t) ? "yes" : "NO "}  ${t}`)
  );
  console.log(`  yes  awaiting_confirmation  (ours - the assignment's list is a minimum)`);

  const missing = required.filter((t) => !allTypes.has(t));
  console.log(
    `\n  ${missing.length === 0 ? "PASS — all five event types emitted." : "MISSING: " + missing.join(", ")}`
  );

  await disconnectDB();
  console.log("");
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  await disconnectDB();
  process.exit(1);
});
