# Build 1 — Status Against the Assignment

Scored against `docs/assignment.md`. Updated as we go.

---

## Marks coverage

| Criteria | Marks | Status | What is missing |
|---|---|---|---|
| Agent Loop Correctness | 25 | **~80%** | Persist iterations to MongoDB |
| Tool Design | 20 | **~25%** | 7 of 8 tools |
| Safety Rails | 20 | **0%** | Code limits, confirmation flow, grounding |
| Streaming & Activity Visibility | 15 | 0% | SSE |
| Trace Persistence & Viewer | 10 | **~50%** | In memory only; no viewer |
| RAG Grounding with Citations | 10 | 0% | ChromaDB |
| **Total** | **100** | **~30%** | |

---

## Done

**The agent loop** (`src/agent/agentRunner.js`)
- Explicit loop, hand-written, no framework abstraction
- Iteration cap — **8**, the value the assignment suggests
- Token budget — 30,000 cumulative per request, aborts cleanly
- Graceful termination on all three exits, each returning a usable message plus
  the full trace rather than throwing
- Tool errors do not kill the loop

**Tool infrastructure** (`src/tools/toolRegistry.js`)
- Registry pattern — verified: adding a tool needs zero loop changes
- JSON schema per tool
- Validation before execution: unknown tool, malformed JSON, missing fields,
  wrong types, unexpected fields, numeric ranges
- Structured errors (`{error, message}`), never thrown
- Handler exceptions caught

**Trace** — per iteration: duration, tokens, content, and per tool call: id,
name, raw arguments, result, ok flag, duration. Returned via `/chat`.

**Transport** (`src/server.js`) — `POST /chat`, boundary validation, JSON 404,
graceful shutdown, errors logged in full and returned in summary.

---

## Not done

### Tools — 1 of 8

| Tool | Status |
|---|---|
| `getCustomer(email)` | Done |
| `getOrders(customerId, limit)` | Not started |
| `getInvoices(customerId)` | Not started |
| `checkRefundEligibility(orderId)` | Not started |
| `issueRefund(orderId, amount, reason)` | Not started |
| `applyAccountCredit(customerId, amount)` | Not started |
| `escalateToHuman(reason, priority)` | Not started |
| `searchKnowledgeBase(query)` | Needs ChromaDB |

Note on `checkRefundEligibility`: the assignment says **"the agent must not
decide eligibility itself"** — the policy logic lives in the tool, and the agent
only reads its verdict.

### Safety Rails — 0 of 20 marks

Three separate requirements, none started:

1. **Code-enforced limits.** `issueRefund` rejects above-threshold amounts at
   the function level. The assignment is blunt: *"A refund limit enforced only in
   the system prompt fails this build outright."* Thresholds are chosen and
   defended in `docs/autonomy-policy.md`.
2. **Confirmation flow.** *"Any write tool must be confirmed by the user in the
   UI before it executes."* This has a backend consequence: a write tool cannot
   simply run inside the loop — the run has to pause, surface the proposed
   action, and resume on confirmation. That is a loop change, not just a UI one.
3. **Grounding.** Policy answers come from retrieved documents with citations;
   the agent says it doesn't know rather than inventing policy.

### Three failure paths must be demonstrated

The assignment requires all three shown explicitly:

| Path | Status |
|---|---|
| A tool returning an error | Done — `test-agent.js` Part 3 |
| The iteration cap being hit | Not demonstrated |
| A rejected out-of-policy refund | Blocked on `issueRefund` |

### Infrastructure

| Requirement | Status | Notes |
|---|---|---|
| MongoDB | Not started | conversations, messages, tool call records, customers, orders, invoices, refunds |
| Redis | Not started | conversation state, per-user rate limiting |
| ChromaDB | Not started | policy + help article retrieval |
| SSE streaming | Not started | 5 event types: thinking, tool_call, tool_result, token, done |
| Correlation ID logging | Not started | one ID per agent run |
| React frontend | Not started | chat, trace viewer, confirmation modal, token counter |

---

## Revised plan

Current data is hardcoded in the registry. That was right for proving the loop,
and it stops being right the moment we need orders and invoices that relate to
each other.

| Step | Work | Marks unlocked |
|---|---|---|
| **4** | Remaining read tools + seed data (`getOrders`, `getInvoices`, `checkRefundEligibility`) | Tool Design |
| **5** | Write tools + code-enforced limits (`issueRefund`, `applyAccountCredit`, `escalateToHuman`) | **Safety Rails** |
| **6** | Demonstrate all three failure paths | Loop Correctness |
| **7** | MongoDB — replace hardcoded data, persist trace | Trace Persistence |
| **8** | SSE streaming | Streaming |
| **9** | ChromaDB + `searchKnowledgeBase` with citations | RAG Grounding |
| **10** | React frontend | Frontend, Trace Viewer |
| **11** | Redis — state + rate limiting | Backend Requirements |

Steps 4–6 are worth the most marks per hour and depend on nothing new. Doing
them before the databases keeps the "one new thing at a time" rule intact.

### The confirmation-flow decision, flagged early

Build 1 needs write tools confirmed in the UI; Build 2 replaces that with a full
approval queue that survives a server restart.

Worth designing the Build 1 pause so Build 2 extends it rather than replaces it.
The cheap version — run the loop, stop before a write, return the proposed
action — has the same shape as Build 2's pause, just without durable state.
Deciding this at Step 5 rather than Step 7 avoids a rewrite.

---

## The end-to-end target

The assignment's own worked example:

> "My last invoice charged me twice — please refund the duplicate and tell me
> why it happened."

Requires: `getCustomer` → `getInvoices` → identify duplicate →
`checkRefundEligibility` → `issueRefund` → explain. Five tool-using iterations,
inside a cap of 8.

Seed data must contain a customer with an actual duplicate charge, or this case
cannot be demonstrated. That is a Step 4 requirement.
