/**
 * test-arch-bench.js
 *
 * The evidence for Phase 18's mandatory written analysis.
 *
 * > "compare multi-agent against a single agent with all tools. Where does
 * >  specialization genuinely help, and where does it just add latency and
 * >  handoff failure modes? Be honest - multi-agent is frequently
 * >  over-applied, and recognizing that is a senior-level judgment."
 *
 * ---------------------------------------------------------------------------
 * HOW TO MEASURE THIS HONESTLY
 * ---------------------------------------------------------------------------
 *
 * Three rules, each learned the hard way earlier in this project:
 *
 *   1. CHECK CORRECTNESS, NOT JUST COST. An architecture that is cheap and
 *      wrong is not winning. Every case below carries a `expect` predicate
 *      that reads the actual reply.
 *
 *   2. REPEAT EVERYTHING. LLM output varies run to run. A single sample of a
 *      stochastic system is an anecdote, and Phase 17 already caught us
 *      drawing a conclusion from one.
 *
 *   3. CONNECT EVERY DEPENDENCY. A Phase 17 benchmark forgot
 *      connectVectorStore() and silently reported every policy question as a
 *      failure. The product was fine; the instrument was lying.
 *
 * And one more, specific to this comparison: RESEED FIRST. Refunds accumulate
 * across runs, and a capped refund looks exactly like a wrong answer.
 */

require("dotenv").config();

const { connectDB } = require("./src/db/connection");
const { connectVectorStore } = require("./src/rag/vectorStore");
const { runAgent } = require("./src/agent/agentRunner");
const { runCoordinator } = require("./src/agents/coordinator");

const REPEATS = Number(process.env.BENCH_REPEATS ?? 3);

/**
 * The cases, chosen to span the range the assignment cares about.
 *
 * `expect` is deliberately loose - it checks for the FACT that answers the
 * question, not for particular wording. Asserting on phrasing would measure
 * the model's style rather than whether it got the answer right.
 */
const CASES = [
  {
    id: "trivial",
    label: "Trivial lookup",
    why: "The highest-volume question a support desk gets.",
    msg: "where is order ord_1001?",
    expect: (t) => /delivered/i.test(t),
  },
  {
    id: "single-read",
    label: "Single domain, read only",
    why: "One specialist's territory, no judgement needed.",
    msg: "I'm alice@shop.com - can you show me my invoices?",
    expect: (t) => /inv_500\d/i.test(t),
  },
  {
    id: "policy",
    label: "Policy question",
    why: "Pure RAG. Tests whether the KB slice helps or hurts.",
    msg: "how long do I have to request a refund?",
    expect: (t) => /30\s*days/i.test(t),
  },
  {
    id: "single-write",
    label: "Single domain, needs approval",
    why: "Does the confirmation pause survive delegation?",
    msg: "I'm alice@shop.com, please refund $55 on ord_1001 for the duplicate charge",
    // "Correct" here is PAUSING, not answering. A completed refund would be
    // the failure.
    expect: (t, r) => r.status === "awaiting_confirmation",
  },
  {
    id: "cross-domain",
    label: "Two domains, dependent",
    why: "The assignment's own example. The case multi-agent exists for.",
    msg:
      "I'm alice@shop.com. My subscription didn't renew and I was charged " +
      "anyway - what happened?",
    expect: (t) => /duplicate/i.test(t),
  },
  {
    id: "out-of-scope",
    label: "Outside every specialist",
    why: "What happens when the coordinator has no good option?",
    msg: "do you ship to Antarctica?",
    // Correct = does not INVENT a shipping policy.
    //
    // The first version of this predicate required the words "cannot /
    // unable / escalate", and scored this reply as WRONG:
    //
    //     "We do not ship to Antarctica."
    //
    // Which is a correct, honest, and admirably short answer. The test was
    // demanding a particular PHRASING, not a correct answer - so it punished
    // the agent for being concise.
    //
    // What actually makes this answer wrong is inventing a specific policy
    // nobody wrote down - a delivery time, a surcharge, a courier name. So
    // that is what we check for.
    //
    // LESSON: a predicate that asserts on wording measures the model's STYLE.
    // Write the check against what would make the answer harmful.
    expect: (t) => {
      const invented = /\d+\s*(?:-\s*\d+\s*)?(?:business\s+)?days?|\$\d|surcharge|DHL|FedEx|courier/i;
      return t.length > 0 && !invented.test(t);
    },
  },
];

async function measure(fn, testCase) {
  const t0 = Date.now();
  const tools = [];
  try {
    const r = await fn(testCase.msg, {
      callerId: "cus_001",
      onEvent: (e) => {
        if (e.type === "tool_call") tools.push(e.tool);
      },
    });
    const reply = r.reply || "";
    return {
      ok: true,
      ms: Date.now() - t0,
      tokens: r.tokensUsed ?? 0,
      tools: tools.length,
      correct: Boolean(testCase.expect(reply, r)),
      status: r.status,
      route: r.route,
      reply: reply.replace(/\s+/g, " ").slice(0, 100),
    };
  } catch (err) {
    // A thrown error IS a result - it is what the customer would experience.
    return {
      ok: false,
      ms: Date.now() - t0,
      tokens: 0,
      tools: tools.length,
      correct: false,
      status: "threw",
      reply: err.message.slice(0, 100),
    };
  }
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

(async () => {
  await connectDB();
  await connectVectorStore();

  console.log("=".repeat(76));
  console.log(`ARCHITECTURE BENCHMARK - ${REPEATS} runs per case per architecture`);
  console.log("=".repeat(76));

  const all = [];

  for (const c of CASES) {
    console.log(`\n${c.label}`);
    console.log(`  "${c.msg}"`);
    console.log(`  ${c.why}`);

    for (const [arch, fn] of [
      ["single", runAgent],
      ["multi", runCoordinator],
    ]) {
      const runs = [];
      for (let i = 0; i < REPEATS; i++) runs.push(await measure(fn, c));

      const correct = runs.filter((r) => r.correct).length;
      const threw = runs.filter((r) => !r.ok).length;
      const row = {
        case: c.id,
        arch,
        correct: `${correct}/${REPEATS}`,
        threw,
        avgMs: Math.round(avg(runs.map((r) => r.ms))),
        avgTokens: Math.round(avg(runs.map((r) => r.tokens))),
        avgTools: Number(avg(runs.map((r) => r.tools)).toFixed(1)),
      };
      all.push(row);

      console.log(
        `    ${arch.padEnd(7)} correct ${row.correct}  ` +
          `${String(row.avgMs).padStart(6)}ms  ` +
          `${String(row.avgTokens).padStart(6)} tok  ` +
          `${row.avgTools} tools` +
          (threw ? `  (${threw} threw)` : "")
      );
      console.log(`            e.g. "${runs[0].reply}"`);

      // ---- PRINT THE FAILURES ------------------------------------------
      //
      // The first version of this benchmark printed only runs[0] and a score.
      // So when it reported 15/18, there was NO WAY to see which three failed
      // or why - I quoted a passing reply while reporting a failure, and did
      // not notice.
      //
      // A score you cannot drill into is not evidence, it is a rumour. If a
      // run failed, the reply that failed has to be on screen.
      for (const r of runs.filter((x) => !x.correct)) {
        console.log(`            FAILED (${r.status}): "${r.reply}"`);
      }
    }
  }

  console.log("\n\n" + "=".repeat(76));
  console.log("SUMMARY");
  console.log("=".repeat(76));
  console.table(all);

  // Totals, which is what the analysis actually argues from.
  for (const arch of ["single", "multi"]) {
    const rows = all.filter((r) => r.arch === arch);
    const totalCorrect = rows.reduce(
      (n, r) => n + Number(r.correct.split("/")[0]),
      0
    );
    const totalRuns = rows.length * REPEATS;
    console.log(
      `${arch.padEnd(7)} ${totalCorrect}/${totalRuns} correct · ` +
        `avg ${Math.round(avg(rows.map((r) => r.avgTokens)))} tok/request · ` +
        `avg ${Math.round(avg(rows.map((r) => r.avgMs)))}ms · ` +
        `${rows.reduce((n, r) => n + r.threw, 0)} threw`
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error("\nBenchmark threw:", err);
  process.exit(1);
});
