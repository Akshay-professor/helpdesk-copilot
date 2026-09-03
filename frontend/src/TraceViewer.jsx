import { useState } from "react";

/**
 * TraceViewer
 *
 * The assignment: "Trace viewer: expandable per-message view showing every
 * iteration — reasoning, tool name, arguments, result, duration."
 *
 * Every field it asks for is already in the trace the backend returns, so this
 * component is mostly presentation. That is the payoff from recording the trace
 * properly back at Step 3 rather than bolting it on now.
 *
 * Collapsed by default: a five-iteration run with full tool results is a wall
 * of JSON. You want to SEE the shape of the run and drill into the one step you
 * care about.
 */
export default function TraceViewer({ trace, tokensUsed, iterations, runId }) {
  if (!trace || trace.length === 0) {
    return (
      <>
        <h3>Trace</h3>
        <div className="empty">
          Send a message and every iteration will appear here — tool calls,
          arguments, results, and timings.
        </div>
      </>
    );
  }

  return (
    <>
      <h3>Trace</h3>

      {/* The assignment's "cost/token counter per conversation" */}
      <div className="stat-row">
        <span>{iterations} iterations</span>
        <span>{tokensUsed?.toLocaleString() ?? 0} tokens</span>
        {runId && <span title={runId}>run {runId.slice(0, 8)}</span>}
      </div>

      {trace.map((entry, i) => (
        <Iteration key={i} entry={entry} />
      ))}
    </>
  );
}

function Iteration({ entry }) {
  const [open, setOpen] = useState(false);

  const calls = entry.toolCalls ?? [];
  const failed = calls.some((c) => !c.ok);

  return (
    <div className="iter">
      <div className="iter-head" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"}</span>
        <span className="iter-n">
          {entry.resumed ? "resumed" : `#${entry.iteration}`}
        </span>
        <span style={{ color: failed ? "var(--danger)" : undefined }}>
          {calls.length > 0
            ? calls.map((c) => c.name).join(", ")
            : entry.content
              ? "final answer"
              : "—"}
        </span>
        <span className="iter-meta">
          {entry.durationMs ? `${entry.durationMs}ms` : ""}
          {entry.tokens ? ` · ${entry.tokens}t` : ""}
        </span>
      </div>

      {open && (
        <div className="iter-body">
          {entry.content && (
            <div className="kv">
              <div className="kv-label">reasoning / answer</div>
              <div>{entry.content}</div>
            </div>
          )}

          {calls.map((c, i) => (
            <div className="tool-entry" key={i}>
              <div className={`tool-name ${c.ok ? "" : "bad"}`}>
                {c.name} {c.ok ? "✓" : "✗"}{" "}
                <span style={{ color: "var(--muted)" }}>{c.durationMs}ms</span>
                {c.confirmed !== undefined && (
                  <span style={{ color: "var(--warn)" }}>
                    {" "}
                    {c.confirmed ? "· confirmed" : "· declined"}
                    {c.modified ? " · modified" : ""}
                  </span>
                )}
              </div>

              <div className="kv">
                <div className="kv-label">arguments</div>
                <pre className="json">{formatJson(c.rawArguments)}</pre>
              </div>

              <div className="kv">
                <div className="kv-label">result</div>
                <pre className="json">{JSON.stringify(c.result, null, 2)}</pre>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tool arguments arrive as a JSON string. Pretty-print, tolerate garbage. */
function formatJson(raw) {
  try {
    return JSON.stringify(typeof raw === "string" ? JSON.parse(raw) : raw, null, 2);
  } catch {
    return String(raw);
  }
}
