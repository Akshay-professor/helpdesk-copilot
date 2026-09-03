/**
 * api.js
 *
 * Everything that talks to the backend. Components call these functions and
 * never touch fetch directly — the same adapter idea as llmClient.js on the
 * server.
 */

/**
 * Send a message and receive events as the agent works.
 *
 * WHY NOT `EventSource`?
 * The browser's built-in SSE client only does GET requests, and we need to POST
 * a message body. So we read the response stream by hand — which is a few more
 * lines, but not difficult once you see the shape.
 *
 * @param {string}   message
 * @param {Array}    history   prior conversation
 * @param {Function} onEvent   called with each {type, ...data} as it arrives
 * @returns {Promise<Object>}  the final result payload
 */
export async function streamChat(message, history, onEvent, multiAgent = false) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `multiAgent` picks the architecture on the SAME endpoint, so the two are
    // directly comparable - same validation, same rate limiting, same response
    // shape. Only the architecture differs.
    body: JSON.stringify({ message, history, multiAgent }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server returned ${response.status}: ${text.slice(0, 200)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  // Network chunks do NOT align with SSE events. One chunk may hold three
  // events, or half of one. So we accumulate into a buffer and only consume
  // complete events — those terminated by a blank line.
  //
  // Getting this wrong is the classic SSE bug: it works on a fast local
  // connection where events happen to arrive whole, then breaks in production
  // when they get split.
  let buffer = "";
  let finalResult = null;
  let sawDone = false;

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      // The connection died mid-stream - server restarted, network dropped,
      // proxy timed out. Without this catch the promise never settles and the
      // UI hangs on "thinking..." forever with no error, which is exactly what
      // happens when `node --watch` restarts the backend mid-request.
      throw new Error(
        "Connection lost while the agent was working. " +
          "If the backend restarted, try again."
      );
    }

    const { done, value } = chunk;
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // "\n\n" terminates an event. Split on it, and keep the last piece — it is
    // either empty or a partial event still arriving.
    const parts = buffer.split("\n\n");
    buffer = parts.pop();

    for (const part of parts) {
      if (!part.trim()) continue;

      let type = "message";
      let data = "";
      for (const rawLine of part.split("\n")) {
        if (rawLine.startsWith("event:")) type = rawLine.slice(6).trim();
        else if (rawLine.startsWith("data:")) data += rawLine.slice(5).trim();
      }

      if (!data) continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // malformed frame — skip rather than kill the stream
      }

      if (type === "result") finalResult = parsed;
      else {
        if (type === "done") sawDone = true;
        onEvent({ type, ...parsed });
      }
    }
  }

  // The stream ended without a result. That means it was cut short - the
  // backend died, or a proxy closed the connection. Say so plainly rather than
  // returning null, which the caller would silently treat as "nothing to show".
  if (!finalResult) {
    throw new Error(
      sawDone
        ? "The agent finished but the final result did not arrive. Try again."
        : "The connection closed before the agent finished. " +
          "If the backend restarted, try again."
    );
  }

  return finalResult;
}

/** Approve, reject, or modify a paused write action. */
export async function confirmAction(state, approved, options = {}) {
  const response = await fetch("/api/chat/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, approved, ...options }),
  });
  if (!response.ok) {
    throw new Error(`Confirm failed: ${response.status}`);
  }
  return response.json();
}

/** Backend health, including whether Mongo and Chroma are reachable. */
export async function getHealth() {
  const r = await fetch("/api/health");
  return r.json();
}

/** One stored run, with its full trace. */
export async function getRun(runId) {
  const r = await fetch(`/api/runs/${runId}`);
  if (!r.ok) throw new Error(`Run ${runId} not found`);
  return r.json();
}

// ---------------------------------------------------------------------------
// The operator queue
//
// Note what these do NOT send: the paused state. In Build 1 the browser held
// it and posted it back, which meant closing the tab lost the approval. Now
// the state lives in MongoDB and an operator acts on a run by ID alone - from
// any machine, hours later, on a server that never saw the original request.
// ---------------------------------------------------------------------------

/** Everything waiting for a human. */
export async function getApprovals() {
  const r = await fetch("/api/approvals");
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message || `Could not load the queue (${r.status})`);
  }
  return r.json();
}

/**
 * Approve, reject, or modify a pending action.
 *
 * A 409 here is not an error to hide - it means somebody else already actioned
 * this one, which is exactly what the idempotency guard is for. The UI should
 * say so plainly rather than showing a generic failure.
 */
export async function resolveApproval(runId, approved, options = {}) {
  const r = await fetch(`/api/approvals/${runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved, ...options }),
  });

  if (r.status === 409) {
    const body = await r.json().catch(() => ({}));
    const err = new Error(body.message || "Already actioned.");
    err.alreadyResolved = true;
    throw err;
  }

  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message || `Could not resolve (${r.status})`);
  }
  return r.json();
}

/** How traffic split across the three routes. */
export async function getRouting() {
  const r = await fetch("/api/routing");
  if (!r.ok) throw new Error("Routing analytics unavailable");
  return r.json();
}

/**
 * Per-agent cost tracking.
 *
 * The assignment: "Cost tracking dashboard: latency, tokens, and tool calls
 * per agent - multi-agent multiplies LLM calls; the numbers you see here are
 * your evidence for the written analysis."
 */
export async function getCosts() {
  const r = await fetch("/api/costs");
  if (!r.ok) throw new Error("Cost analytics unavailable");
  return r.json();
}
