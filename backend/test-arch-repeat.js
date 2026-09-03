/**
 * test-arch-repeat.js
 *
 * The two-domain case decides the whole written analysis, so one sample is
 * not enough. LLM output varies run to run; a conclusion drawn from a single
 * measurement of a stochastic system is an anecdote.
 *
 * Three runs each, same request, both architectures.
 */
require("dotenv").config();
const { connectDB } = require("./src/db/connection");
const { connectVectorStore } = require("./src/rag/vectorStore");
const { runAgent } = require("./src/agent/agentRunner");
const { runCoordinator } = require("./src/agents/coordinator");

const MSG =
  "I'm alice@shop.com. My subscription didn't renew and I was charged anyway - what happened?";
const RUNS = 3;

// Did the answer actually contain the fact that resolves the question?
const answered = (t) => /duplicate/i.test(t || "");

async function sample(fn, label) {
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    try {
      const r = await fn(MSG, { callerId: "cus_001" });
      rows.push({
        arch: label,
        run: i + 1,
        ms: Date.now() - t0,
        tokens: r.tokensUsed ?? 0,
        found: answered(r.reply) ? "YES" : "no",
        reply: (r.reply || "").replace(/\s+/g, " ").slice(0, 90),
      });
    } catch (err) {
      rows.push({ arch: label, run: i + 1, ms: Date.now() - t0, tokens: 0, found: "ERR", reply: err.message.slice(0, 90) });
    }
  }
  return rows;
}

(async () => {
  await connectDB();
  await connectVectorStore();

  const rows = [
    ...(await sample(runAgent, "single")),
    ...(await sample(runCoordinator, "multi")),
  ];

  console.table(rows);

  for (const arch of ["single", "multi"]) {
    const r = rows.filter((x) => x.arch === arch);
    const ok = r.filter((x) => x.found === "YES").length;
    const avgTok = Math.round(r.reduce((n, x) => n + x.tokens, 0) / r.length);
    const avgMs = Math.round(r.reduce((n, x) => n + x.ms, 0) / r.length);
    console.log(
      `${arch.padEnd(7)} found the duplicate ${ok}/${RUNS} times · ` +
        `avg ${avgTok} tok · avg ${avgMs}ms`
    );
  }
  process.exit(0);
})();
