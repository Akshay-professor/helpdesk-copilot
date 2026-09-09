import { useState, useEffect, useRef } from "react";
import { streamChat, confirmAction, getHealth } from "./api";
import ConfirmModal from "./ConfirmModal";
import TraceViewer from "./TraceViewer";
import OperatorQueue from "./OperatorQueue";
import VoiceCall from "./VoiceCall";
import ResearchPanel from "./ResearchPanel";
import Markdown from "./Markdown";
import CostDashboard from "./CostDashboard";
import { getApprovals } from "./api";

/**
 * App
 *
 * The four things the assignment asks the frontend to do:
 *
 *   1. Chat with LIVE agent activity - each tool call visible as it happens,
 *      not a spinner
 *   2. Trace viewer - every iteration, expandable
 *   3. Confirmation modal before any write executes
 *   4. Cost/token counter
 *
 * Conversation state lives here, in the client. The server is stateless (it
 * returns `history` and we send it back), which is what lets the backend be
 * restarted mid-conversation without losing anything.
 */
export default function App() {
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // Live activity for the run currently in flight.
  const [activity, setActivity] = useState([]);

  // Set when the agent pauses on a write tool. Its presence renders the modal.
  const [pending, setPending] = useState(null);

  const [trace, setTrace] = useState(null);
  const [stats, setStats] = useState({ tokensUsed: 0, iterations: 0, runId: null });
  const [health, setHealth] = useState(null);

  // Which screen: the customer chat, or the operator approval queue.
  const [view, setView] = useState("chat");
  const [pendingCount, setPendingCount] = useState(0);

  // Which architecture handles the next request. A per-request toggle rather
  // than a config file, because the whole point of Phase 18 is comparing the
  // two on the SAME question - and you cannot do that if switching means a
  // restart.
  const [multiAgent, setMultiAgent] = useState(false);

  const startedAt = useRef(0);
  const scrollRef = useRef(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ status: "unreachable" }));
  }, []);

  // Poll the queue count so the operator sees a badge without opening the tab.
  // An approval sitting unnoticed is the same as no approval queue at all.
  useEffect(() => {
    const check = () =>
      getApprovals()
        .then((q) => setPendingCount(q.approvals.length))
        .catch(() => setPendingCount(0));
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, [view, busy]);

  // Keep the newest message in view as things stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, activity]);

  /** Fold a finished/paused result into the UI. Shared by send and confirm. */
  function applyResult(result) {
    if (!result) return;

    setHistory(result.history ?? []);
    setTrace(result.trace ?? []);
    setStats({
      tokensUsed: result.tokensUsed ?? 0,
      iterations: result.iterations ?? 0,
      runId: result.trace?.[0]?.runId ?? result.runId ?? null,
    });

    if (result.status === "awaiting_confirmation") {
      // ---- WHO IS BEING ASKED? -------------------------------------------
      //
      // Two different pauses wear the same status, and showing the customer
      // the wrong one is a real problem:
      //
      //   requiresOperator = false   the CUSTOMER can confirm their own small
      //                              refund. Show them the modal.
      //
      //   requiresOperator = true    a SUPERVISOR must decide. Putting an
      //                              Approve button in front of the customer
      //                              for a $205 refund asks the person who
      //                              RECEIVES the money to authorise it -
      //                              which is not an approval, it is a
      //                              formality with a button.
      //
      // In the second case the customer is told what happens next, and the
      // item waits in the Approvals tab where a supervisor works the queue.
      const c = result.confirmation ?? result.pending;
      const needsOperator = c?.requiresOperator || c?.summary?.requiresOperator;

      if (needsOperator) {
        setPending(null);
        const what = c.detail ?? c.summary?.detail ?? "your request";
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text:
              "I've sent this to our support team for approval: " +
              what +
              ". You'll hear back once it has been reviewed — usually within the hour.",
          },
        ]);
      } else {
        // Hold the whole result: /chat/confirm needs `state` back verbatim.
        setPending(result);
      }
    } else {
      setPending(null);
      if (result.reply) {
        setMessages((m) => [...m, { role: "assistant", text: result.reply }]);
      }
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setActivity([]);
    setBusy(true);
    startedAt.current = Date.now();

    try {
      const result = await streamChat(
        text,
        history,
        (event) => {
          setActivity((a) => [...a, { ...event, ms: Date.now() - startedAt.current }]);
        },
        multiAgent
      );
      applyResult(result);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `Error: ${err.message}`, error: true },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove(modifiedArguments) {
    setBusy(true);
    try {
      const result = await confirmAction(pending.state, true, { modifiedArguments });
      applyResult(result);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${err.message}`, error: true }]);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(rejectionNote) {
    setBusy(true);
    try {
      const result = await confirmAction(pending.state, false, { rejectionNote });
      applyResult(result);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${err.message}`, error: true }]);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>HelpDesk Copilot</h1>

        <div className="tabs">
          <button
            className={`tab ${view === "chat" ? "on" : ""}`}
            onClick={() => setView("chat")}
          >
            Chat
          </button>
          <button
            className={`tab ${view === "queue" ? "on" : ""}`}
            onClick={() => setView("queue")}
          >
            Approvals
            {pendingCount > 0 && <span className="count">{pendingCount}</span>}
          </button>
          <button
            className={`tab ${view === "costs" ? "on" : ""}`}
            onClick={() => setView("costs")}
          >
            Costs
          </button>
          <button
            className={`tab ${view === "voice" ? "on" : ""}`}
            onClick={() => setView("voice")}
          >
            Voice
          </button>
          <button
            className={`tab ${view === "research" ? "on" : ""}`}
            onClick={() => setView("research")}
          >
            Research
          </button>
        </div>

        <label className="toggle" title="Route this request through the coordinator and its specialists">
          <input
            type="checkbox"
            checked={multiAgent}
            onChange={(e) => setMultiAgent(e.target.checked)}
          />
          multi-agent
        </label>

        <div className="spacer" />
        <span className={`pill ${health?.database === "connected" ? "ok" : "bad"}`}>
          db {health?.database ?? "?"}
        </span>
        <span className={`pill ${health?.knowledgeBase === "connected" ? "ok" : "bad"}`}>
          kb {health?.knowledgeBase ?? "?"}
        </span>
        <span className="pill">{stats.tokensUsed.toLocaleString()} tokens</span>
      </div>

      {/*
        HIDE, DO NOT UNMOUNT.

        These were conditionally rendered, which means React DESTROYED the
        component whenever you switched tabs - and every piece of state inside
        it went with it. Switch away from Voice mid-call and you hung up:
        the WebSocket closed, the transcript vanished, the microphone stopped.

        Chat survived only by accident, because its state happens to live up
        here in App rather than in a child.

        `hidden` keeps the component mounted and its state alive while removing
        it from view (index.css sets [hidden] { display: none }). The cost is
        that a hidden tab keeps polling; the benefit is that a phone call does
        not end because you glanced at the approvals queue.
      */}
      <div hidden={view !== "research"} className="tabpanel">
        <ResearchPanel active={view === "research"} />
      </div>

      <div hidden={view !== "voice"} className="tabpanel">
        <VoiceCall active={view === "voice"} />
      </div>
      <div hidden={view !== "queue"} className="tabpanel">
        <OperatorQueue />
      </div>
      <div hidden={view !== "costs"} className="tabpanel">
        <CostDashboard />
      </div>

      <div hidden={view !== "chat"} className="tabpanel">
      <div className="body">
        <div className="chat-pane">
          <div className="messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="empty">
                Ask about an order, an invoice, or a policy.
                <br />
                <br />
                Try: <em>"I'm alice@shop.com — was I charged twice?"</em>
              </div>
            )}

            {messages.map((m, i) => (
              <div className={`msg ${m.role}`} key={i}>
                <div className="msg-role">{m.role}</div>
                <div
                  className="msg-body"
                  style={m.error ? { color: "var(--danger)" } : undefined}
                >
                  {/* The model writes markdown. Printing it raw showed
                      customers "| Order ID |---|" and "**ord_1001**". The
                      renderer builds React elements, never HTML strings, so
                      model output cannot inject markup. */}
                  {m.role === "assistant" && !m.error ? (
                    <Markdown text={m.text} />
                  ) : (
                    m.text
                  )}
                </div>
              </div>
            ))}

            {activity.length > 0 && (busy || pending) && (
              <ActivityFeed events={activity} />
            )}
          </div>

          <div className="composer">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={pending ? "Respond to the confirmation first…" : "Ask something…"}
              disabled={busy || !!pending}
            />
            <button className="btn-primary" onClick={send} disabled={busy || !!pending}>
              {busy ? "…" : "Send"}
            </button>
          </div>
        </div>

        <div className="trace-pane">
          <TraceViewer
            trace={trace}
            tokensUsed={stats.tokensUsed}
            iterations={stats.iterations}
            runId={stats.runId}
          />
        </div>
      </div>
      </div>

      <ConfirmModal
        confirmation={pending?.confirmation}
        onApprove={handleApprove}
        onReject={handleReject}
        busy={busy}
      />
    </div>
  );
}

/**
 * The live activity feed — the assignment's "the user sees each tool being
 * called as it happens, not a spinner".
 *
 * Timings are shown deliberately. A user who can see that getInvoices took
 * 12ms and the model took 800ms understands where time goes; a spinner teaches
 * them nothing.
 */
function ActivityFeed({ events }) {
  return (
    <div className="activity">
      {events.map((e, i) => (
        <div className="act-row" key={i}>
          <span className="act-time">{e.ms}ms</span>
          <span className={`act-kind ${e.type} ${e.ok === false ? "bad" : ""}`}>
            {e.type}
          </span>
          <span className="act-text">
            {/* Which agent did this. Without the tag, a merged multi-agent
                trace is unreadable - you cannot tell who made which call,
                which is exactly what you need when one misbehaves. */}
            {e.specialist && <span className="act-agent">{e.specialist}</span>}
            {describe(e)}
          </span>
        </div>
      ))}
    </div>
  );
}

function describe(e) {
  switch (e.type) {
    // ---- Build 3: the multi-agent events -------------------------------
    case "coordinated":
      return e.mode === "workflow"
        ? "no agent needed - deterministic workflow"
        : `${e.mode}: ${e.specialists.join(" → ")} · ${e.reason}`;
    case "delegated":
      return `→ ${e.label} (${e.toolCount} tools): ${e.task}`;
    case "specialist_done":
      return `${e.status} · ${e.tokensUsed} tokens · ${e.durationMs}ms`;
    case "specialist_failed":
      return `FAILED: ${e.error}`;
    case "delegation_capped":
      return `delegation cap hit (${e.limit}) - answering with what we have`;

    case "thinking":
      return e.message;
    case "tool_call":
      return `${e.tool}(${JSON.stringify(e.args)})`;
    case "tool_result":
      return `${e.tool} → ${e.summary}`;
    case "awaiting_confirmation":
      return e.summary?.detail ?? "waiting for confirmation";
    case "token":
      return "answer received";
    case "done":
      return `${e.status} · ${e.iterations} iterations · ${e.tokensUsed} tokens`;
    default:
      return "";
  }
}
