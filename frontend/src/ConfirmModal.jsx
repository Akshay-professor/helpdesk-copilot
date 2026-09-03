import { useState } from "react";

/**
 * ConfirmModal
 *
 * The assignment: "Confirmation modal for write actions, showing exactly what
 * will happen before it happens."
 *
 * Note the phrasing — "exactly what will happen". So this shows the sentence
 * the tool wrote about itself ("Refund $50.00 for order ord_1001 to Alice
 * Martin"), not raw JSON arguments. The raw arguments are available underneath
 * for anyone who wants them, but they are not the headline.
 *
 * The Modify field is a Build 2 requirement (Approve / Reject / Modify) that
 * costs almost nothing here because resumeAgent already accepts edited
 * arguments — and re-validates them, so editing an amount upward cannot get
 * past the policy ceiling.
 */
export default function ConfirmModal({ confirmation, onApprove, onReject, busy }) {
  const [modified, setModified] = useState(null);
  const [note, setNote] = useState("");

  if (!confirmation) return null;

  const { action, detail, reason, irreversible, warning, tool, arguments: args } = confirmation;

  // Only amounts are editable. A human adjusting "how much" is the realistic
  // case; letting them rewrite an order ID would just be a way to act on the
  // wrong record.
  const editableAmount = typeof args?.amount === "number";
  const amountValue = modified ?? args?.amount;

  const approve = () => {
    const changed = editableAmount && Number(amountValue) !== args.amount;
    onApprove(changed ? { ...args, amount: Number(amountValue) } : undefined);
  };

  return (
    <div className="overlay">
      <div className="modal">
        <h2>{action}</h2>
        <div className="msg-role">{tool}</div>

        <div className="detail">{detail}</div>
        {reason && <div className="reason">Reason: {reason}</div>}

        {irreversible && warning && <div className="warning">⚠ {warning}</div>}

        {editableAmount && (
          <div className="field">
            <label>Amount (edit to change what the agent does)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={amountValue}
              onChange={(e) => setModified(e.target.value)}
              disabled={busy}
            />
          </div>
        )}

        <div className="field">
          <label>Note if rejecting (optional — the agent reads this)</label>
          <input
            type="text"
            value={note}
            placeholder="e.g. customer wants store credit instead"
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
        </div>

        <details>
          <summary className="msg-role" style={{ cursor: "pointer" }}>
            Raw arguments
          </summary>
          <div className="args">{JSON.stringify(args, null, 2)}</div>
        </details>

        <div className="modal-actions">
          <button className="btn-danger" onClick={() => onReject(note)} disabled={busy}>
            Reject
          </button>
          <button className="btn-primary" onClick={approve} disabled={busy}>
            {busy ? "Working…" : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
