/**
 * test-arch-compare.js
 *
 * The MANDATORY written analysis needs numbers, not opinions.
 *
 * "compare multi-agent against a single agent with all tools. Where does
 *  specialization genuinely help, and where does it just add latency and
 *  handoff failure modes? Be honest - multi-agent is frequently over-applied,
 *  and recognizing that is a senior-level judgment."
 *
 * Same requests, both architectures, measured. Whatever the numbers say is
 * what goes in the analysis.
 */
require("dotenv").config();
const { connectDB } = require("./src/db/connection");
// Connect the KB too. Forgetting this made every policy question in an
// earlier benchmark run return "knowledge_base_unavailable" - the product
// was fine, the HARNESS was lying. A measurement that quietly degrades the
// thing it measures is worse than no measurement.
const { connectVectorStore } = require("./src/rag/vectorStore");
const { runAgent } = require("./src/agent/agentRunner");
const { runCoordinator } = require("./src/agents/coordinator");

const CASES = [
  { label: "trivial lookup",   msg: "where is order ord_1001?" },
  { label: "single domain",    msg: "I'm alice@shop.com - can you show me my invoices?" },
  { label: "policy question",  msg: "how long do I have to request a refund?" },
  { label: "two domains",      msg: "I'm alice@shop.com. My subscription didn't renew and I was charged anyway - what happened?" },
];

async function measure(fn, msg) {
  const t0 = Date.now();
  const tools = [];
  try {
    const r = await fn(msg, {
      callerId: "cus_001",
      onEvent: (e) => { if (e.type === "tool_call") tools.push(e.tool); },
    });
    return {
      ms: Date.now() - t0,
      tokens: r.tokensUsed ?? 0,
      status: r.status,
      route: r.route,
      tools: tools.length,
      reply: (r.reply || "").replace(/\s+/g, " ").slice(0, 150),
    };
  } catch (err) {
    return { ms: Date.now() - t0, tokens: 0, status: "ERROR: " + err.message, tools: 0, reply: "" };
  }
}

(async () => {
  await connectDB();
  await connectVectorStore();
  const rows = [];

  for (const c of CASES) {
    console.log("\n" + "=".repeat(70));
    console.log(`${c.label.toUpperCase()}: "${c.msg}"`);
    console.log("=".repeat(70));

    const single = await measure(runAgent, c.msg);
    console.log(`  single-agent : ${String(single.ms).padStart(6)}ms  ${String(single.tokens).padStart(6)} tok  route=${single.route}  tools=${single.tools}`);
    console.log(`                 "${single.reply}"`);

    const multi = await measure(runCoordinator, c.msg);
    console.log(`  multi-agent  : ${String(multi.ms).padStart(6)}ms  ${String(multi.tokens).padStart(6)} tok  route=${multi.route}  tools=${multi.tools}`);
    console.log(`                 "${multi.reply}"`);

    const tokMult = single.tokens === 0 ? Infinity : (multi.tokens / single.tokens);
    rows.push({
      case: c.label,
      "single ms": single.ms, "single tok": single.tokens,
      "multi ms": multi.ms,   "multi tok": multi.tokens,
      "x slower": (multi.ms / single.ms).toFixed(1) + "x",
      "x tokens": tokMult === Infinity ? "inf" : tokMult.toFixed(1) + "x",
    });
  }

  console.log("\n\nSUMMARY");
  console.table(rows);
  process.exit(0);
})();
