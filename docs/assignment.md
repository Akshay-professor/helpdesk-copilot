# Phase 3 Agent Engineering — Project Assignment

**Authoritative copy.** Transcribed from the assignment PDF. This supersedes
`assignment-extracted.txt`, which was machine-extracted and partly garbled.

Full-Stack MERN + Agentic AI | Production-Level Build

---

## What this phase is really about

Phase 2 taught you to call an LLM and ground it with RAG. That produces a system
that **answers questions**. Agent engineering produces a system that **takes
actions** — it decides what to do, does it, checks whether it worked, and knows
when to stop and ask a human.

> A chatbot that returns a wrong answer wastes a user's time. An agent that
> decides wrongly issues a refund, sends an email, or deletes a record. **Every
> requirement in this assignment exists because of that difference.**

### Skill mapping — every Phase 3 topic is forced by this build, not bolted on

| Phase 3 Topic | Where it becomes unavoidable |
|---|---|
| AI Agent Fundamentals | Build 1 — the core agent loop |
| Tool Usage | Build 1 — tools with real side effects |
| Planning | Build 2 — multi-step tickets needing a plan before action |
| Reflection | Build 2 — the agent grading its own output before returning it |
| Human-in-the-Loop | Build 2 — approval gates on irreversible actions |
| Workflow vs Autonomous Agents | Build 2 — choose per task type and defend it |
| Multi-Agent Systems | Build 3 — specialist agents with a coordinator |
| Multi-Agent Research System | Build 3 — the research agent pattern |
| Voice AI with RAG | Build 3 — voice channel over the same agent core |

### Overview

One system, three builds. **Each build is reviewed before the next starts.**

| Build | Focus | Duration |
|---|---|---|
| 1 | Single agent, tool calling, streaming, safety rails | 20–25 hrs |
| 2 | Planning, reflection, HITL, workflow-vs-autonomous routing | 25–30 hrs |
| 3 | Multi-agent orchestration, research agent, voice channel | 25–30 hrs |

---

# THE PROJECT — HelpDesk Copilot

## The Domain

A SaaS support team handles tickets that require **doing things**, not just
answering questions:

> "My last invoice charged me twice — please refund the duplicate and tell me
> why it happened."

Answering this requires: looking up the customer, fetching their invoice
history, identifying the duplicate charge, checking refund eligibility against
policy, issuing the refund (irreversible, money moves), and explaining the root
cause. That is **retrieval, reasoning, a policy check, a side-effecting action,
and a written explanation — in one request.**

## Why This Domain

| Action | Reversible? | Should the agent do it alone? |
|---|---|---|
| Look up order status | Yes (read-only) | Yes — fully autonomous |
| Draft a reply | Yes | Yes |
| Apply a $10 account credit | Mostly | Yes, within policy limits |
| Issue a $2,400 refund | No | No — human approval required |
| Delete a customer account | No | Never — always escalate |

> That gradient is exactly what makes human-in-the-loop, autonomy boundaries,
> and reflection real design requirements instead of textbook concepts.

---

# BUILD 1 — Single Agent with Tool Calling

**Difficulty** ⭐⭐⭐⭐☆ | 20–25 Hours

## Objective

Build a working agent loop: the LLM receives a request, decides which tools to
call, calls them, observes results, and either continues or produces a final
answer. **Everything else in this project sits on top of this loop, so it must
be correct and observable.**

## Tech Stack

- Backend: Node.js + Express
- Frontend: React or Next.js
- DB: MongoDB + Mongoose
- Cache/State: Redis
- LLM: any provider with native tool-calling support
- Vector store: ChromaDB (policy/knowledge retrieval)
- Streaming: SSE

## The Agent Loop

Implement the core cycle explicitly — **do not use a framework's black-box
`agent.run()`. You must own this loop:**

1. Send conversation + tool definitions to the LLM
2. Model responds with either a tool call OR a final answer
3. If tool call → execute it → append the result to the conversation → repeat from 1
4. If final answer → stream to user, end

### Hard requirements on the loop

- **Max iteration cap (e.g. 8)** — an agent that loops forever burns money and
  hangs the request. Cap it and handle hitting the cap gracefully
- **Every iteration persisted** — the full trace (thought → tool call →
  arguments → result) must be inspectable afterwards
- **Token budget per request** — track cumulative tokens, abort cleanly if
  exceeded

## Tools (minimum 7, with real behavior)

| Tool | Type | Notes |
|---|---|---|
| `searchKnowledgeBase(query)` | Read | ChromaDB retrieval over help articles + policy docs |
| `getCustomer(email)` | Read | MongoDB |
| `getOrders(customerId, limit)` | Read | MongoDB |
| `getInvoices(customerId)` | Read | MongoDB |
| `checkRefundEligibility(orderId)` | Read + logic | Evaluates policy rules — **the agent must not decide eligibility itself** |
| `issueRefund(orderId, amount, reason)` | Write — irreversible | Money moves |
| `applyAccountCredit(customerId, amount)` | Write | Bounded by policy |
| `escalateToHuman(reason, priority)` | Write | Creates a human queue entry |

**Every tool must have:** a JSON schema, input validation before execution
(*never trust LLM-generated arguments — the model will produce malformed or
out-of-range values, this is expected*), and structured error returns the agent
can reason about (`{error: "customer_not_found", message: "..."}` — **not a
thrown exception that kills the loop**).

## Safety Rails (mandatory in Build 1)

- **Hard policy limits enforced in code, not in the prompt.** `issueRefund` must
  reject amounts above a threshold at the function level. A prompt saying "never
  refund over $500" is a suggestion; a code check is a guarantee. **This
  distinction is the single most important safety lesson in agent engineering**
- **Confirmation requirement:** any write tool must be confirmed by the user in
  the UI before it executes (Build 2 replaces this with a proper approval
  workflow)
- **Grounding:** policy answers must come from retrieved documents, with
  citations. The agent must say it doesn't know rather than invent policy

## Streaming (SSE)

Stream more than tokens — stream the agent's **activity**:

```
event: thinking     → "Analyzing the request..."
event: tool_call    → { tool: "getInvoices", args: {...} }
event: tool_result  → { tool: "getInvoices", summary: "Found 12 invoices" }
event: token        → partial final answer text
event: done         → { iterations: 4, tokensUsed: 3200, toolsCalled: [...] }
```

## Frontend (React)

- Chat interface with **live agent activity** — the user sees each tool being
  called as it happens, not a spinner
- **Trace viewer:** expandable per-message view showing every iteration —
  reasoning, tool name, arguments, result, duration
- **Confirmation modal** for write actions, showing exactly what will happen
  before it happens
- **Cost/token counter** per conversation

## Backend Requirements

- **Tool registry pattern** — adding a tool must be one registration, with zero
  changes to the agent loop
- **MongoDB:** conversations, messages, tool call records (with args, results,
  duration, success/failure), customers, orders, invoices, refunds
- **Redis:** conversation state, per-user rate limiting on agent requests (agent
  calls are expensive — an unbounded loop is a real cost incident)
- **Structured logging with a correlation ID per agent run** — one request may
  involve 8 LLM calls and 15 tool executions; that must be reconstructable from
  logs

## Evaluation Criteria

| Criteria | Marks |
|---|---|
| Agent Loop Correctness (iteration cap, error recovery, termination) | 25 |
| Tool Design (schemas, validation, structured errors) | 20 |
| Safety Rails (code-enforced limits, confirmation flow) | 20 |
| Streaming & Activity Visibility | 15 |
| Trace Persistence & Viewer | 10 |
| RAG Grounding with Citations | 10 |
| **Total** | **100** |

## Important Instructions

- **No framework `agent.run()` abstraction** — you must implement and own the
  loop. You can use frameworks in Build 3 once you've proven you understand what
  they're hiding
- **A refund limit enforced only in the system prompt fails this build outright**
- **Demonstrate the failure paths:** a tool returning an error, the iteration cap
  being hit, and a rejected out-of-policy refund

---

# BUILD 2 — Planning, Reflection & Human-in-the-Loop

**Difficulty** ⭐⭐⭐⭐⭐ | 25–30 Hours

## Objective

Build 1's agent is reactive — it decides one step at a time. Real tickets need a
plan before acting, a quality check before responding, and a human before doing
anything irreversible.

## Planning

- For any request classified as **multi-step**, the agent produces an explicit
  plan before executing anything: an ordered list of steps, each naming the tool
  it will use and its expected outcome
- The plan is **persisted and shown to the user** before execution begins
- **Replanning:** when a step fails or returns something unexpected, the agent
  revises the remaining plan rather than blindly continuing. Track and display
  plan revisions — a plan that changed twice mid-execution is a signal worth
  seeing
- **Design decision to defend:** which requests need a plan at all? Planning
  costs latency and tokens; "where's my order" doesn't need one. Where's your
  threshold, and how is it determined?

## Reflection

- Before returning any final answer, a reflection pass evaluates the draft
  against explicit criteria: Does it answer the actual question? Is every claim
  grounded in a tool result or retrieved doc? Is the tone appropriate? Did it
  leak internal details?
- If reflection fails, the agent revises — **capped at 2 revision attempts**
  (unbounded self-revision is a cost and latency trap)
- **Both the reflection verdict and the original draft must be persisted** — you
  need to see what was rejected and why, and this becomes your quality dataset
- **Design decision to defend:** same model for reflection, or a
  cheaper/different one? There's a real tradeoff between cost, latency, and the
  known weakness of a model evaluating its own output

## Human-in-the-Loop (the centerpiece)

| Condition | Behavior |
|---|---|
| Read-only tools | Autonomous |
| Writes under policy threshold | Autonomous, logged |
| Writes over threshold | Paused — agent queues an approval request and waits |
| Explicit escalation triggers (legal, security, account deletion) | Always human, agent never acts |

- When paused, the agent run must **persist its full state and resume correctly
  when approved** — possibly minutes or hours later, possibly on a different
  server instance. **This is the hardest engineering problem in Build 2: an agent
  loop that survives suspension**
- **Agent operator queue (frontend):** pending approvals showing the request, the
  agent's reasoning, the exact action proposed, and the customer context — with
  **Approve / Reject / Modify** (human edits the amount, agent proceeds with the
  edited value)
- **Rejection handling:** a rejected action must not crash the run — the agent
  must incorporate the rejection and respond to the customer appropriately

## Workflow vs Autonomous Routing

Not every ticket needs an agent. Implement a classifier that routes requests:

| Route | When | Example |
|---|---|---|
| Deterministic workflow (no LLM decisions) | High-volume, fully predictable | "Where is my order?" → fixed lookup → templated reply |
| Guided agent (constrained tool subset) | Known category, some judgment needed | Refund requests → only refund-related tools available |
| Autonomous agent (full toolset) | Novel or ambiguous | Anything not matching a known pattern |

**You must implement all three paths and document why each category routes where
it does.** Track the distribution — what percentage of traffic actually needs an
autonomous agent? That number is the argument for this whole design, and it's
usually surprisingly low.

## Frontend additions

- Plan viewer: steps, live status, revisions highlighted
- Reflection panel: draft vs final, with the reflection verdict
- Approval queue with Approve/Reject/Modify
- Routing analytics: traffic split across the three paths

## Backend Requirements

- **Durable agent state:** a paused run must survive a server restart. Redis for
  hot state, MongoDB for durability — and a clear reasoning for what lives where
- **Timeout on pending approvals:** what happens if no human responds in 24
  hours? Design and defend it
- **Idempotent resumption:** approving twice (double-click, retry) must not
  execute the action twice

## Evaluation Criteria

| Criteria | Marks |
|---|---|
| Planning + Replanning Correctness | 20 |
| Reflection Loop (criteria, revision cap, persistence) | 20 |
| HITL: Pause, Persist, Resume Correctness | 25 |
| Approval Queue (incl. Modify + rejection handling) | 10 |
| Workflow vs Autonomous Routing (implemented + justified) | 15 |
| Idempotency of Resumption | 10 |
| **Total** | **100** |

## Important Instructions

- **Demonstrate pause → restart the server → approve → agent resumes correctly.
  An in-memory pause fails this build**
- Reflection that always passes is not reflection — show a case where it caught
  and fixed a bad draft
- If every request routes to the autonomous agent, the routing layer isn't doing
  its job

---

# BUILD 3 — Multi-Agent System, Research Agent & Voice

**Difficulty** ⭐⭐⭐⭐⭐ | 25–30 Hours

## Objective

Split one over-loaded agent into specialists with a coordinator, add a research
agent, and expose the whole system over voice. **This is where you learn what
multi-agent actually buys you — and where it costs more than it's worth.**

## Multi-Agent Architecture

| Agent | Owns | Tools |
|---|---|---|
| Coordinator | Classifies intent, delegates, assembles the final response | Delegation only — no domain tools |
| Billing Agent | Invoices, refunds, credits, payment issues | Billing tools + billing policy KB |
| Technical Agent | Product issues, troubleshooting, bug triage | Technical KB, system status, log lookup |
| Account Agent | Profile, subscription, plan changes | Account tools |
| Research Agent | Open-ended investigation | Read-only, multi-source |

- Each agent has its **own system prompt, own tool subset, own KB collection** —
  the isolation is the point: a billing agent that can't touch account-deletion
  tools cannot misuse them
- **Coordinator handoff protocol:** a documented contract for what's passed to a
  specialist and what comes back. **Design decision to defend:** full
  conversation history, or a summarized brief? (context cost vs information loss)
- **Multi-agent requests:** "My subscription didn't renew and I was charged
  anyway" touches Account + Billing. The coordinator must sequence or parallelize
  them and merge results coherently
- **Loop prevention:** agents must not hand off back and forth indefinitely. Cap
  delegation depth and handle hitting the cap
- **Mandatory written analysis:** compare multi-agent against a single agent with
  all tools. Where does specialization genuinely help, and where does it just add
  latency and handoff failure modes? Be honest — **multi-agent is frequently
  over-applied, and recognizing that is a senior-level judgment**

## Research Agent

For open-ended questions — *"Are customers on the Pro plan churning more than
last quarter, and why?"*:

- Decomposes the question into sub-questions
- Investigates each **in parallel**, from multiple sources: ticket history
  (vector search), structured DB aggregation, KB docs
- Synthesizes findings into a report **with citations to every source used**
- States its own confidence and **explicitly names what it couldn't determine** —
  "I found X but couldn't verify Y" is a correct and valuable answer; a confident
  fabrication is the failure mode this guards against
- **Long-running:** streams progress ("Investigating 3 of 5 sub-questions..."),
  and must survive being closed and reopened

## Voice Channel

Expose the agent over voice, **reusing the same core (not a parallel
implementation)**:

- Browser mic capture → STT → agent → TTS → playback
- **Streaming both directions** — waiting for a full response before speaking
  makes it feel broken. Target sub-second time-to-first-audio
- Voice-specific design problems you must solve:
  - Responses must be **rewritten for speech** — a formatted table or bulleted
    list is unspeakable. Same agent core, different output formatter
  - Tool execution takes seconds; **silence feels like a dropped call.** Design
    the filler/progress behavior
  - **HITL over voice:** how does an approval-required action work when the user
    is on a call? This has no obvious answer — design one and defend it
  - **Barge-in:** the user interrupts mid-response. Handle it

## Frontend Requirements (Build 3)

Decoded from the PDF's Build 3 frontend/evaluation block. The glyph extraction
interleaves two columns, so this is the reconstruction — the individual phrases
are all verbatim from `assignment-extracted.txt` line 96.

- **Multi-agent visualizer:** a live agent-activity view showing which agent
  handled what, the handoffs between them, and a timeline of the run
- **Research report view:** expandable findings with per-finding citations and
  confidence indicators
- **Voice interface:** streaming transcript, waveform, and voice-specific
  activity indicators
- **Shared memory dashboard** across agents
- **Cost tracking dashboard:** latency, tokens, and tool calls per agent —
  "multi-agent multiplies LLM calls; the numbers you see here are your evidence
  for the written analysis"

## Backend Requirements (Build 3)

- **Agent registry** — adding a specialist is *configuration*, not surgery on
  the coordinator
- **Voice:** WebSocket, with the **JWT in the header, not the URL** (URLs land
  in access logs); **TTS response caching** for repeated phrases
- The voice agent **must reuse the Build 1/2 agent core** — not a separate
  voice-only implementation

## Evaluation Criteria — Build 3

| Criteria | Marks |
|---|---|
| Multi-Agent Architecture (isolation, handoff contract, loop prevention) | 20 |
| Coordinator Routing & Merging | 15 |
| Research Agent (decomposition, parallel investigation, citations, confidence) | 20 |
| Voice Channel (streaming, voice-specific handling) | 20 |
| Multi-Agent vs Single-Agent Written Analysis (with real measured numbers) | 15 |
| Cost Tracking (per agent: latency, tokens, tool calls) | 10 |
| **Total** | **100** |

> "The multi-agent comparison must be measured on real data — a report that
> never says *'I couldn't determine this'* is fabricating; you must be able to
> demonstrate a case where it correctly reports uncertainty."

## Important Instructions

- Demonstrate the **failure paths, not the happy path**.
