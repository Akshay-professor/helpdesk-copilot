import { useState, useEffect, useCallback } from "react";
import { getCosts, getRouting } from "./api";

/**
 * CostDashboard
 *
 * The assignment asks for this by name, and says exactly what it is for:
 *
 *   "Cost tracking dashboard: latency, tokens, and tool calls per agent -
 *    multi-agent multiplies LLM calls; the numbers you see here are your
 *    evidence for the written analysis."
 *
 * That last clause is the design brief. This screen is not decoration and it
 * is not for a customer - it is the instrument that settles an architectural
 * argument. So it shows the numbers that could CHANGE a decision, and it puts
 * the uncomfortable one at the top.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SEPARATE FROM THE ROUTING BAR
 * ---------------------------------------------------------------------------
 *
 * The routing bar (Phase 16) groups by ROUTE and answers a Build 2 question:
 * "what fraction of traffic needs an agent at all?"
 *
 * This groups by AGENT and answers a Build 3 question: "what does each
 * specialist cost us?" Knowing specialists are expensive is not actionable.
 * Knowing WHICH one is.
 */
export default function CostDashboard() {
  const [costs, setCosts] = useState(null);
  const [routing, setRouting] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        getCosts(),
        getRouting().catch(() => null),
      ]);
      setCosts(c);
      setRouting(r);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    // Costs accumulate over hours, not seconds. Polling faster would just be
    // load with no new information.
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="queue"><div className="notice bad">{error}</div></div>;
  if (!costs) return <div className="queue"><div className="empty">Loading…</div></div>;

  const single = costs.agents.find((a) => a.agent === "single-agent");
  const specialists = costs.agents.filter((a) => a.agent !== "single-agent");

  const specTokens = specialists.reduce((n, a) => n + a.totalTokens, 0);
  const specRuns = specialists.reduce((n, a) => n + a.runs, 0);
  const specAvg = specRuns ? Math.round(specTokens / specRuns) : 0;

  return (
    <div className="queue">
      <div className="queue-head">
        <h2>Cost tracking</h2>
        <span className="muted small">
          {costs.totalRuns} runs · {costs.totalTokens.toLocaleString()} tokens ·
          refreshes every 30s
        </span>
        <div className="grow" />
        <button className="ctl" onClick={load}>Refresh</button>
      </div>

      <Verdict single={single} specAvg={specAvg} specRuns={specRuns} />

      <h3 className="section">Per agent</h3>
      <div className="cost-table">
        <div className="cost-row cost-head">
          <span>Agent</span>
          <span>Runs</span>
          <span>Avg tokens</span>
          <span>Avg latency</span>
          <span>Tool calls / run</span>
          <span>Share of spend</span>
        </div>
        {costs.agents.map((a) => (
          <div className="cost-row" key={a.agent}>
            <span className={`agent-name ${a.agent === "single-agent" ? "base" : ""}`}>
              {a.agent}
            </span>
            <span>{a.runs}</span>
            <span>{a.avgTokens.toLocaleString()}</span>
            <span>{(a.avgDurationMs / 1000).toFixed(1)}s</span>
            <span>{a.avgToolCalls}</span>
            <span>
              <span className="spend-bar">
                <i style={{ width: `${Math.min(a.shareOfSpend, 100)}%` }} />
              </span>
              {a.shareOfSpend}%
            </span>
          </div>
        ))}
      </div>

      {routing?.routes?.length > 0 && (
        <>
          <h3 className="section">Per route</h3>
          <div className="cost-table">
            <div className="cost-row cost-head route-row">
              <span>Route</span>
              <span>Runs</span>
              <span>Share</span>
              <span>Avg tokens</span>
              <span>Avg latency</span>
            </div>
            {routing.routes.map((r) => (
              <div className="cost-row route-row" key={r.route}>
                <span className="agent-name">{r.route}</span>
                <span>{r.count}</span>
                <span>{r.percentage}%</span>
                <span>{r.avgTokens.toLocaleString()}</span>
                <span>{(r.avgDurationMs / 1000).toFixed(1)}s</span>
              </div>
            ))}
          </div>
          <p className="muted small note-line">
            The <strong>workflow</strong> row costs zero tokens. Every request
            it handles is one the agent never had to think about.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The headline number, stated plainly.
 *
 * A dashboard that makes you do arithmetic to find the point is a dashboard
 * nobody reads. If specialists cost more per answer, say so in a sentence and
 * put it above the table - especially when it is the answer we did not want.
 */
function Verdict({ single, specAvg, specRuns }) {
  if (!single || specRuns === 0) {
    return (
      <div className="verdict neutral">
        Not enough multi-agent traffic yet to compare. Send a few requests with
        multi-agent enabled.
      </div>
    );
  }

  const ratio = specAvg / (single.avgTokens || 1);
  const pct = Math.round((ratio - 1) * 100);
  const dearer = pct > 0;

  return (
    <div className={`verdict ${dearer ? "warn" : "ok"}`}>
      <div className="verdict-line">
        A specialist run averages{" "}
        <strong>{specAvg.toLocaleString()} tokens</strong>; the single agent
        averages <strong>{single.avgTokens.toLocaleString()}</strong>.
      </div>
      <div className="verdict-sub">
        {dearer ? (
          <>
            Specialists cost <strong>{pct}% more per run</strong> — and a
            multi-agent request usually runs <em>more than one</em> of them,
            plus a coordinator call to decide. That is the multi-agent tax, and
            it is what the written analysis has to justify.
          </>
        ) : (
          <>
            Specialists are currently cheaper per run — expected, since each has
            a smaller toolbox and a scoped brief. The cost appears when one
            request needs two of them.
          </>
        )}
      </div>
    </div>
  );
}
