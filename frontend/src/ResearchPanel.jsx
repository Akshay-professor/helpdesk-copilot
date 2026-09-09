import { useState, useEffect, useCallback, useRef } from "react";

/**
 * ResearchPanel
 *
 * The assignment's research-report view: "expandable findings with per-finding
 * citations and confidence indicators".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN LOOKS DIFFERENT FROM THE CHAT
 * ---------------------------------------------------------------------------
 *
 * Chat answers arrive in seconds. A research run takes a minute or more, and
 * the assignment is explicit that it must "stream progress" and "survive being
 * closed and reopened".
 *
 * So this screen shows two things a chat window never has to:
 *
 *   1. WHAT IT IS DOING RIGHT NOW - "investigating 3 of 5 sub-questions". A
 *      minute of silence reads as a hang.
 *   2. WHAT IT COULD NOT FIND - the gaps. A report with no gaps and high
 *      confidence on thin data is the failure mode this whole feature guards
 *      against, so the gaps are shown as prominently as the findings.
 *
 * The history list on the left is the "survives being closed" half: reports are
 * written when the investigation STARTS, so you can close the tab, come back,
 * and open the finished one.
 */

const CONF = {
  high: { label: "High confidence", color: "var(--ok)" },
  medium: { label: "Medium confidence", color: "var(--warn)" },
  low: { label: "Low confidence", color: "var(--danger)" },
};

export default function ResearchPanel({ active = true }) {
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState([]);
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/research");
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      setHistory((await r.json()).reports ?? []);
    } catch {
      /* history is a convenience - never block the screen on it */
    }
  }, []);

  useEffect(() => {
    if (active) loadHistory();
  }, [active, loadHistory]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [progress]);

  async function open(reportId) {
    setError(null);
    setProgress([]);
    try {
      const r = await fetch(`/api/research/${reportId}`);
      if (!r.ok) throw new Error(`Server returned ${r.status}`);
      setReport(await r.json());
    } catch (err) {
      setError(err.message);
    }
  }

  async function start() {
    const q = question.trim();
    if (!q || running) return;

    setRunning(true);
    setReport(null);
    setProgress([]);
    setError(null);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      // Same SSE reader as the chat. Chunks split anywhere, so accumulate in a
      // buffer and only parse complete "\n\n"-terminated events - the bug that
      // cost an afternoon in Build 1.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const block of parts) {
          const type = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
          const raw = block.match(/^data:\s*([\s\S]*)$/m)?.[1];
          if (!type || !raw) continue;

          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            continue;
          }

          if (type === "report") setReport(data);
          else if (type === "error") setError(data.message ?? "Research failed.");
          else
            setProgress((p) => [
              ...p,
              { type, text: describe(type, data), at: Date.now() },
            ]);
        }
      }
      await loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="research">
      <div className="research-head">
        <h2>Research agent</h2>
        <span className="muted small">
          Open-ended questions. Decomposes, investigates in parallel, cites
          sources, and says what it could not determine.
        </span>
      </div>

      <div className="research-ask">
        <input
          value={question}
          placeholder="e.g. Are gold-tier customers requesting more refunds than standard-tier?"
          disabled={running}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
        />
        <button className="btn-primary" onClick={start} disabled={running || !question.trim()}>
          {running ? "Investigating…" : "Investigate"}
        </button>
      </div>

      {error && <div className="notice bad">{error}</div>}

      <div className="research-body">
        <aside className="research-history">
          <div className="muted small" style={{ marginBottom: 8 }}>
            Past reports ({history.length})
          </div>
          {history.length === 0 && (
            <div className="muted small">Nothing yet.</div>
          )}
          {history.map((h) => (
            <button
              key={h.reportId}
              className={`hist ${report?.reportId === h.reportId ? "on" : ""}`}
              onClick={() => open(h.reportId)}
            >
              <span className="hist-q">{h.question}</span>
              <span className="hist-meta">
                {h.confidence && (
                  <i style={{ background: CONF[h.confidence]?.color }} />
                )}
                {new Date(h.createdAt).toLocaleTimeString()}
              </span>
            </button>
          ))}
        </aside>

        <main className="research-main" ref={scrollRef}>
          {running && progress.length > 0 && (
            <div className="research-progress">
              {progress.map((p, i) => (
                <div key={i}>{p.text}</div>
              ))}
            </div>
          )}

          {!report && !running && (
            <div className="empty">
              Ask an open-ended question, or open a past report.
              <br />
              <br />
              Good ones for this dataset:
              <br />
              <em>"Which routing path uses the most tokens per run?"</em>
              <br />
              <em>"Are Pro plan customers churning more than last quarter?"</em>
              <br />
              <br />
              The second one <strong>should come back low-confidence</strong> —
              there are only three customers. An honest "I could not determine
              this" is the correct answer, and the failure this guards against.
            </div>
          )}

          {report && <Report report={report} />}
        </main>
      </div>
    </div>
  );
}

function Report({ report }) {
  const [openQ, setOpenQ] = useState(null);
  const conf = CONF[report.confidence] ?? CONF.low;

  return (
    <article className="report">
      <h3>{report.question}</h3>

      <div className="report-bar">
        <span className="conf" style={{ borderColor: conf.color, color: conf.color }}>
          {conf.label}
        </span>
        <span className="muted small">
          {report.subQuestions?.length ?? 0} sub-questions ·{" "}
          {report.citations?.length ?? 0} citations ·{" "}
          {report.tokensUsed?.toLocaleString() ?? 0} tokens
          {report.durationMs ? ` · ${(report.durationMs / 1000).toFixed(1)}s` : ""}
        </span>
      </div>

      {report.confidenceReason && (
        <div className="muted small conf-why">{report.confidenceReason}</div>
      )}

      {/* GAPS FIRST, deliberately.
          A report that never says "I could not determine this" is fabricating,
          and burying that at the bottom lets a reader miss the one thing that
          should change how much they trust the rest. */}
      {report.gaps?.length > 0 && (
        <div className="gaps">
          <div className="gaps-title">
            Could not determine ({report.gaps.length})
          </div>
          <ul>
            {report.gaps.map((g, i) => (
              <li key={i}>{typeof g === "string" ? g : g.text ?? JSON.stringify(g)}</li>
            ))}
          </ul>
        </div>
      )}

      {report.report && <div className="report-body">{report.report}</div>}

      {report.subQuestions?.length > 0 && (
        <div className="subqs">
          <div className="muted small" style={{ marginBottom: 8 }}>
            Sub-questions investigated
          </div>
          {report.subQuestions.map((sq, i) => {
            const q = typeof sq === "string" ? { question: sq } : sq;
            const isOpen = openQ === i;
            return (
              <div className="subq" key={i}>
                <button className="subq-head" onClick={() => setOpenQ(isOpen ? null : i)}>
                  <span className="subq-n">{i + 1}</span>
                  <span>{q.question ?? q.text ?? "(sub-question)"}</span>
                  <span className="muted small" style={{ marginLeft: "auto" }}>
                    {q.findings?.length ?? q.sources?.length ?? 0} findings
                  </span>
                </button>
                {isOpen && (
                  <div className="subq-body">
                    <pre>{JSON.stringify(q, null, 2).slice(0, 2000)}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {report.citations?.length > 0 && (
        <div className="citations">
          <div className="muted small" style={{ marginBottom: 6 }}>
            Sources
          </div>
          <ol>
            {report.citations.map((c, i) => (
              <li key={i}>
                {typeof c === "string" ? c : c.title ?? c.source ?? JSON.stringify(c)}
                {c.detail && <span className="muted small"> — {c.detail}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

function describe(type, d) {
  switch (type) {
    case "research_started":
      return `Starting: ${d.question ?? ""}`;
    case "research_plan":
      return `Decomposed into ${d.subQuestions?.length ?? d.count ?? "?"} sub-questions`;
    case "research_stage":
      return d.stage ?? "working…";
    case "research_progress":
      return d.total
        ? `Investigating ${d.completed ?? d.index ?? "?"} of ${d.total} sub-questions…`
        : d.text ?? "investigating…";
    case "research_confidence":
      return `Confidence: ${d.confidence ?? "?"}${d.reason ? ` — ${d.reason}` : ""}`;
    case "research_complete":
      return "Synthesising the report…";
    default:
      return type;
  }
}
