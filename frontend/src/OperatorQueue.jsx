import { useState, useEffect, useCallback } from "react";
import { getApprovals, resolveApproval, getRouting } from "./api";

/**
 * OperatorQueue
 *
 * The assignment: "Agent operator queue (frontend): pending approvals showing
 * the request, the agent's reasoning, the exact action proposed, and the
 * customer context — with Approve / Reject / Modify."
 *
 * All four are shown, and the REASONING matters as much as the verdict. An
 * operator approving "$240 refund — approve?" with no context is
 * rubber-stamping, not reviewing. Showing which tools ran and what came back is
 * what turns a click into a decision.
 *
 * This screen is for a support supervisor, not the customer. It is deliberately
 * dense: they are working a queue, not reading an article.
 */
export default function OperatorQueue() {
  const [items, setItems] = useState([]);
  const [routing, setRouting] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // runId being actioned
  const [notice, setNotice] = useState(null);
  const [open, setOpen] = useState(null); // expanded runId

  const load = useCallback(async () => {
    try {
      const [q, r] = await Promise.all([
        getApprovals(),
        getRouting().catch(() => null), // analytics are optional
      ]);
      setItems(q.approvals);
      setRouting(r);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    // Poll rather than stream. An approval queue changes when a HUMAN acts,
    // which is minutes apart, not milliseconds - SSE would be a lot of
    // machinery to deliver almost nothing.
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function act(runId, approved, extra = {}) {
    setBusy(runId);
    setNotice(null);
    try {
      const result = await resolveApproval(runId, approved, extra);
      setNotice({
        kind: "ok",
        text: approved
          ? `Approved. ${result.reply?.slice(0, 110) ?? ""}`
          : "Rejected. The agent has responded to the customer.",
      });
      await load();
    } catch (err) {
      // A 409 is the idempotency guard working, not a failure. Say so.
      setNotice({
        kind: err.alreadyResolved ? "warn" : "bad",
        text: err.message,
      });
      if (err.alreadyResolved) await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="queue">
      <div className="queue-head">
        <h2>Approval queue</h2>
        <span className="muted">
          {items.length} pending · refreshes every 10s
        </span>
        <div className="grow" />
        <button className="ctl" onClick={load} disabled={!!busy}>
          Refresh
        </button>
      </div>

      {routing && <RoutingBar routing={routing} />}

      {notice && (
        <div className={`notice ${notice.kind}`}>{notice.text}</div>
      )}

      {error && <div className="notice bad">{error}</div>}

      {!error && items.length === 0 && (
        <div className="empty">
          Nothing waiting for approval.
          <br />
          <br />
          Ask the agent for a refund over $100 in the chat, and it will appear
          here.
        </div>
      )}

      {items.map((item) => (
        <ApprovalCard
          key={item.runId}
          item={item}
          expanded={open === item.runId}
          onToggle={() => setOpen(open === item.runId ? null : item.runId)}
          onAct={act}
          busy={busy === item.runId}
        />
      ))}
    </div>
  );
}

/**
 * The routing distribution.
 *
 * The assignment: "Track the distribution — what percentage of traffic actually
 * needs an autonomous agent? That number is the argument for this whole
 * design." So it belongs on the operator's screen, not buried in a log.
 */
function RoutingBar({ routing }) {
  if (!routing.routes?.length) return null;

  const colour = {
    workflow: "var(--ok)",
    guided: "var(--accent)",
    autonomous: "var(--warn)",
  };

  return (
    <div className="routing">
      <div className="routing-label">
        Traffic split across {routing.total} run{routing.total === 1 ? "" : "s"}
      </div>
      <div className="routing-bar">
        {routing.routes.map((r) => (
          <div
            key={r.route}
            className="routing-seg"
            style={{ width: `${r.percentage}%`, background: colour[r.route] }}
            title={`${r.route}: ${r.percentage}%`}
          />
        ))}
      </div>
      <div className="routing-legend">
        {routing.routes.map((r) => (
          <span key={r.route}>
            <i style={{ background: colour[r.route] }} />
            {r.route} {r.percentage}%
            <em>{r.avgTokens.toLocaleString()} tok avg</em>
          </span>
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({ item, expanded, onToggle, onAct, busy }) {
  const [amount, setAmount] = useState(item.arguments?.amount ?? "");
  const [note, setNote] = useState("");

  const editable = typeof item.arguments?.amount === "number";
  const changed = editable && Number(amount) !== item.arguments.amount;
  const mins = Math.floor(item.ageMs / 60000);

  return (
    <article className={`approval ${item.expired ? "expired" : ""}`}>
      <div className="approval-top">
        <div>
          <div className="action-name">
            {item.action?.action ?? item.tool}
            {item.action?.irreversible && (
              <span className="tag danger">irreversible</span>
            )}
            {item.expired && <span className="tag warn">expired</span>}
          </div>
          <div className="action-detail">{item.action?.detail}</div>
          {item.action?.reason && (
            <div className="muted small">Reason: {item.action.reason}</div>
          )}
        </div>
        <div className="approval-meta">
          <div>{item.callerId ?? "anonymous"}</div>
          <div className="muted">
            {mins < 1 ? "just now" : `${mins}m ago`}
          </div>
        </div>
      </div>

      <div className="customer-said">
        <span className="muted small">Customer asked</span>
        <div>{item.customerMessage}</div>
      </div>

      {item.action?.warning && (
        <div className="warning-line">{item.action.warning}</div>
      )}

      <button className="link" onClick={onToggle}>
        {expanded ? "Hide" : "Show"} the agent's reasoning (
        {item.reasoning.length} step{item.reasoning.length === 1 ? "" : "s"})
      </button>

      {expanded && (
        <div className="reasoning">
          {item.reasoning.map((r, i) =>
            r.type === "tool" ? (
              <div key={i} className="reason-row">
                <span className={`tool ${r.ok ? "" : "bad"}`}>{r.name}</span>
                <pre>{JSON.stringify(r.result, null, 2).slice(0, 500)}</pre>
              </div>
            ) : (
              <div key={i} className="reason-row">
                <span className="muted small">thought</span>
                <div>{r.text}</div>
              </div>
            )
          )}
          <div className="muted small">
            {item.iterations} iterations · {item.tokensUsed?.toLocaleString()}{" "}
            tokens
          </div>
        </div>
      )}

      <div className="approval-actions">
        {editable && (
          <label className="amount">
            <span className="muted small">Amount</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
          </label>
        )}

        <input
          className="note"
          type="text"
          placeholder="Note if rejecting — the agent reads this"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />

        <div className="grow" />

        <button
          className="btn-danger"
          onClick={() => onAct(item.runId, false, { rejectionNote: note })}
          disabled={busy}
        >
          Reject
        </button>
        <button
          className="btn-primary"
          onClick={() =>
            onAct(item.runId, true, {
              // Only send modified arguments when the human actually changed
              // something. Sending them unchanged would mark every approval as
              // "modified" in the audit trail, which is a lie.
              ...(changed && {
                modifiedArguments: {
                  ...item.arguments,
                  amount: Number(amount),
                },
              }),
            })
          }
          disabled={busy}
        >
          {busy ? "Working…" : changed ? `Approve $${amount}` : "Approve"}
        </button>
      </div>
    </article>
  );
}
