import { useState } from "react";

/**
 * RunPanels - the Build 2 and Build 3 views of one run, shown above the trace.
 *
 *   PlanViewer       steps, live status, revisions highlighted
 *   ReflectionPanel  each draft next to its verdict, then what was sent
 *   AgentTimeline    which agent ran when, handoffs on a time axis
 *
 * Everything is derived from data we already have: the live SSE events while
 * the run is in flight, and the final result once it lands. No new endpoint,
 * no extra state on the server.
 */
export default function RunPanels({ events, result }) {
  return (
    <>
      <PlanViewer events={events} result={result} />
      <ReflectionPanel events={events} result={result} />
      <AgentTimeline events={events} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Plan viewer
// ---------------------------------------------------------------------------

const STEP_ICON = { pending: "○", done: "✓", failed: "✗" };

function PlanViewer({ events, result }) {
  const planEvents = events.filter((e) => e.type === "plan");
  // The final result is the source of truth once it exists - it includes steps
  // completed after a resume, which never streamed.
  const steps = result?.plan?.steps ?? planEvents.at(-1)?.plan;
  if (!steps?.length) return null;

  // Revisions are the non-progress plan events after the first. Each one keeps
  // the plan it replaced, so steps that are new in a revision can be marked.
  const versions = planEvents.filter((e) => !e.progress);
  const revisions = versions.filter((e) => e.revision > 0);
  const firstActions = new Set((versions[0]?.plan ?? []).map((s) => s.action));
  const replanning = events.filter((e) => e.type === "replanning");

  return (
    <section className="panel-box">
      <div className="panel-head">
        <span>Plan</span>
        <span className={`badge ${revisions.length ? "warn" : ""}`}>
          {revisions.length === 0
            ? "no revisions"
            : `revised ${revisions.length}×`}
        </span>
      </div>

      <ol className="plan-steps">
        {steps.map((s) => {
          const added = revisions.length > 0 && !firstActions.has(s.action);
          return (
            <li key={s.step} className={`plan-step ${s.status} ${added ? "added" : ""}`}>
              <span className="plan-icon">{STEP_ICON[s.status] ?? "○"}</span>
              <span className="plan-action">
                {s.action}
                {s.tool && <code className="plan-tool">{s.tool}</code>}
                {added && <span className="badge warn">new in revision</span>}
                {s.expected && <div className="muted small">expects: {s.expected}</div>}
              </span>
            </li>
          );
        })}
      </ol>

      {replanning.length > 0 && (
        <div className="plan-revisions">
          {replanning.map((r, i) => (
            <div key={i} className="revision-line">
              <strong>Revision {r.revision}</strong> - {r.reason}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reflection panel
// ---------------------------------------------------------------------------

function ReflectionPanel({ events, result }) {
  const reflections =
    result?.reflections ?? events.filter((e) => e.type === "reflection");
  if (!reflections.length) return null;

  const caught = reflections.filter((r) => r.verdict === "revise").length;
  const final = result?.reply ?? events.findLast?.((e) => e.type === "token")?.text;

  return (
    <section className="panel-box">
      <div className="panel-head">
        <span>Reflection</span>
        <span className={`badge ${caught ? "warn" : "ok"}`}>
          {caught ? `caught ${caught} bad draft${caught > 1 ? "s" : ""}` : "passed first time"}
        </span>
      </div>

      {reflections.map((r, i) => (
        <Attempt key={i} r={r} n={i + 1} />
      ))}

      {caught > 0 && final && (
        <div className="draft final">
          <div className="kv-label">final (sent to customer)</div>
          <div className="draft-text">{final}</div>
        </div>
      )}
    </section>
  );
}

function Attempt({ r, n }) {
  const [open, setOpen] = useState(r.verdict === "revise");
  return (
    <div className={`draft ${r.verdict}`}>
      <div className="draft-head" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"}</span>
        <span>Draft {n}</span>
        <span className={`badge ${r.verdict === "revise" ? "bad" : "ok"}`}>{r.verdict}</span>
        {r.checkedBy && <span className="muted small">checked by {r.checkedBy}</span>}
      </div>
      {open && (
        <>
          {r.failures?.length > 0 && (
            <ul className="failures">
              {r.failures.map((f, i) => (
                <li key={i}>
                  <strong>{f.criterion}</strong>: {f.detail}
                </li>
              ))}
            </ul>
          )}
          {r.draft && <div className="draft-text">{r.draft}</div>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-agent timeline
// ---------------------------------------------------------------------------

function AgentTimeline({ events }) {
  const coordinated = events.find((e) => e.type === "coordinated");
  if (!coordinated || coordinated.mode === "workflow") return null;

  // One bar per agent: coordinator decision, each specialist, then the merge.
  // Lengths come from the durations the backend measured, not from when the
  // events happened to arrive - a buffered stream would otherwise squash them.
  const decideMs = coordinated.latencyMs ?? coordinated.ms;
  const bars = [{ agent: "coordinator", label: "decide", start: 0, end: decideMs, ok: true }];
  for (const d of events.filter((e) => e.type === "delegated")) {
    const end = events.find(
      (e) =>
        (e.type === "specialist_done" || e.type === "specialist_failed") &&
        e.specialist === d.specialist &&
        e.ms >= d.ms
    );
    // A sequential specialist cannot start before the previous one ended.
    const start = coordinated.mode === "sequential"
      ? Math.max(d.ms, ...bars.map((b) => b.end))
      : Math.max(d.ms, decideMs);
    bars.push({
      agent: d.specialist,
      label: end
        ? end.type === "specialist_failed"
          ? "failed"
          : `${end.tokensUsed ?? 0} tokens`
        : "running…",
      start,
      end: start + (end?.durationMs ?? Math.max(0, (events.at(-1)?.ms ?? d.ms) - d.ms)),
      ok: end?.type !== "specialist_failed",
    });
  }
  const lastSpecialistEnd = Math.max(...bars.map((b) => b.end));
  const finished = events.find((e) => e.type === "token" || e.type === "done");
  if (finished && bars.length > 2 && finished.ms > lastSpecialistEnd) {
    bars.push({ agent: "coordinator", label: "merge", start: lastSpecialistEnd, end: finished.ms, ok: true });
  }
  const capped = events.find((e) => e.type === "delegation_capped");

  const total = Math.max(1, ...bars.map((b) => b.end));

  return (
    <section className="panel-box">
      <div className="panel-head">
        <span>Agents</span>
        <span className="badge">
          {coordinated.mode} · {(total / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="timeline">
        {bars.map((b, i) => (
          <div className="tl-row" key={i}>
            <span className="tl-agent">{b.agent}</span>
            <span className="tl-track">
              <span
                className={`tl-bar ${b.ok ? "" : "bad"} ${b.agent === "coordinator" ? "coord" : ""}`}
                style={{
                  left: `${(b.start / total) * 100}%`,
                  width: `${Math.max(1.5, ((b.end - b.start) / total) * 100)}%`,
                }}
                title={`${b.start}ms → ${b.end}ms`}
              />
            </span>
            <span className="tl-label">{b.label}</span>
          </div>
        ))}
      </div>
      <div className="muted small">{coordinated.reason}</div>
      {capped && (
        <div className="revision-line">
          Delegation cap hit ({capped.limit}) - answered with what we had.
        </div>
      )}
    </section>
  );
}
