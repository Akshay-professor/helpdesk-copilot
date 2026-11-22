/**
 * cost-report.js - tokens and $ per request type, from the runs actually
 * stored in MongoDB. Prints markdown; paste it into docs/cost-report.md.
 *
 *   node cost-report.js
 *   COST_PER_MTOK=0.25 node cost-report.js     # your blended $ per 1M tokens
 *
 * WHY A BLENDED RATE. A run's tokensUsed is one number: it mixes the
 * reasoning model's input and output tokens with the small intent
 * classifier's. Splitting them would need per-call accounting we do not store.
 * So $ = tokens x one blended rate, stated in the report header. Set
 * COST_PER_MTOK from your provider's current pricing page; the default is an
 * ASSUMPTION, not a quote.
 */

require("dotenv").config();
const { connectDB, disconnectDB } = require("./src/db/connection");
const { AgentRun, ResearchReport } = require("./src/db/models");

// ponytail: one blended rate; split by model if per-call usage is ever stored.
const COST_PER_MTOK = Number(process.env.COST_PER_MTOK || 0.2);

// Which build introduced each request type - the report is "across all three
// builds", so every row says where it came from.
const BUILD = {
  autonomous: "1 (single agent, all tools)",
  workflow: "2 (deterministic, no LLM)",
  guided: "2 (agent, tool subset)",
  specialist: "3 (one specialist)",
  multi_agent: "3 (coordinator + specialists)",
  research: "3 (research agent)",
};

const usd = (tokens) => (tokens / 1e6) * COST_PER_MTOK;
const fmt$ = (n) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`);

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function row(type, runs) {
  const tokens = runs.map((r) => r.tokensUsed ?? 0).sort((a, b) => a - b);
  const total = tokens.reduce((a, b) => a + b, 0);
  const avg = total / (runs.length || 1);
  const ms = runs.map((r) => r.durationMs ?? 0);
  const avgMs = ms.reduce((a, b) => a + b, 0) / (runs.length || 1);
  return {
    type,
    build: BUILD[type.split(":")[0]] ?? "-",
    n: runs.length,
    avg: Math.round(avg),
    p50: pct(tokens, 50),
    p95: pct(tokens, 95),
    avgMs: Math.round(avgMs),
    perRequest: usd(avg),
    per1k: usd(avg) * 1000,
    total,
  };
}

async function main() {
  if (!(await connectDB())) {
    console.error("MongoDB unreachable - start it, run some traffic, then re-run.");
    process.exit(1);
  }

  const runs = await AgentRun.find(
    {},
    { route: 1, specialist: 1, tokensUsed: 1, durationMs: 1, status: 1, stoppedReason: 1, plan: 1, revisions: 1 }
  ).lean();
  const reports = await ResearchReport.find({}, { tokensUsed: 1, durationMs: 1 }).lean();

  // Request type = route, split by specialist for Build 3 so you can see
  // WHICH specialist the tokens go to.
  const groups = {};
  for (const r of runs) {
    const type = r.route === "specialist" && r.specialist ? `specialist:${r.specialist}` : r.route ?? "unrouted";
    (groups[type] ??= []).push(r);
  }
  if (reports.length) groups.research = reports;

  const rows = Object.entries(groups)
    .map(([t, rs]) => row(t, rs))
    .sort((a, b) => b.n - a.n);
  const all = row("ALL", [...runs, ...reports]);
  const agentRuns = runs.filter((r) => r.route !== "workflow");

  const out = [];
  out.push(`_Generated ${new Date().toISOString().slice(0, 10)} from ${runs.length} agent runs and ${reports.length} research reports. ` +
    `$ uses a blended **$${COST_PER_MTOK}/1M tokens** (COST_PER_MTOK)._\n`);
  out.push("| Request type | Build | Runs | Avg tokens | p50 | p95 | Avg latency | $ / request | $ / 1k requests |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of [...rows, all]) {
    const name = r.type === "ALL" ? "**all traffic**" : `\`${r.type}\``;
    out.push(`| ${name} | ${r.type === "ALL" ? "" : r.build} | ${r.n} | ${r.avg.toLocaleString()} | ${r.p50.toLocaleString()} | ${r.p95.toLocaleString()} | ${(r.avgMs / 1000).toFixed(1)}s | ${fmt$(r.perRequest)} | ${fmt$(r.per1k)} |`);
  }

  const share = (f) => ((agentRuns.filter(f).length / (agentRuns.length || 1)) * 100).toFixed(1);
  out.push("");
  out.push("**Overheads and failure paths** (agent runs only, workflow excluded):\n");
  out.push(`- Planned (one extra LLM call before work): ${share((r) => r.plan)}% of agent runs`);
  out.push(`- Reflection forced at least one revision: ${share((r) => (r.revisions ?? 0) > 0)}%`);
  out.push(`- Stopped at the iteration cap: ${share((r) => r.stoppedReason === "max_iterations")}%`);
  out.push(`- Stopped at the token budget: ${share((r) => r.stoppedReason === "token_budget_exceeded")}%`);
  out.push(`- Paused for approval: ${share((r) => r.status === "awaiting_confirmation" || r.status === "expired")}%`);

  console.log(out.join("\n"));
  await disconnectDB();
}

main().catch((err) => {
  console.error("cost report failed:", err.message);
  process.exit(1);
});
