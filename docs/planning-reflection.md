# Planning and Reflection — Build 2

**Code:** `backend/src/agent/planner.js` · `backend/src/agent/reflection.js` · loop wiring in `agentRunner.js`
**UI:** `frontend/src/RunPanels.jsx` (plan viewer and reflection panel, above the trace)

---

## Planning

### Threshold: plan when the request contains more than one *act*

"More than one tool call" is the wrong threshold. A lookup that needs a customer ID
first is still one act. The question is whether a human would call it two jobs.

| Request | Acts | Plan? |
|---|---|---|
| "where is my order" | 1 | no (and it never reaches the agent: workflow route) |
| "was I charged twice" | 1 | no |
| "refund the duplicate **and** tell me why" | 2 | **yes** |
| "check X, **then if** Y do Z" | ordered | **yes** |

**How it is decided** (`classifyRequest`). The cheap check goes first, because a
classifier that costs an LLM call to decide whether to spend an LLM call has already
spent it.

1. **Code, free.** Short (≤ 12 words), single clause and not irreversible → no plan.
   Multi-act regexes (`and then`, `if … then`, `refund … and … explain`, `tell me why`)
   → plan. Irreversible action inside a long (> 18 words) request → plan.
2. **LLM, one word**, only for what stage 1 can't decide: `MULTI` / `SIMPLE`.
3. If the classifier fails, **don't plan**. The reactive loop has been tested since
   Build 1, so planning is an enhancement, not a dependency.

**Cost:** one extra LLM call before work starts (~1s, a few hundred tokens) on the
requests that get a plan. The cost report shows the share of agent runs that planned.

### The plan

`makePlan()` returns 2–6 steps, each `{step, action, tool, expected, status}`. It is:

- **shown before execution.** A `plan` SSE event fires before the loop starts.
- **persisted** on the `AgentRun` (`plan`, `planRevisions`), including across a pause,
  because a run that resumes mid-plan has to know which steps are done.
- **given to the model** as a system message. A plan the model can't see is decoration.

### Replanning

`shouldReplan()` runs after each iteration's tool calls. "Unexpected" is **not** the
same as "failed":

| Trigger | Example |
|---|---|
| Tool error (except retryable `invalid_arguments` / `invalid_json`) | `getInvoices → customer_not_found` |
| Success that **contradicts the plan** | `checkRefundEligibility → eligible: false`. The call worked, and every remaining step (issue refund, confirm) is now wrong |
| Success that found nothing | `found: 0` |

`revisePlan()` keeps completed steps unchanged (they happened) and rewrites the rest.
The model is told its plan changed, so it doesn't keep executing the old one from
context. Capped at **`MAX_PLAN_REVISIONS = 2`**. Revising forever is the same trap as
reflecting forever.

**Visible:** the plan viewer shows live step status (✓ / ✗ / ○, via `plan` events with
`progress: true`), a "revised N×" badge, each revision's reason, and highlights steps
that are *new in a revision*.

---

## Reflection

### Criteria and who checks them

Every draft is graded before the customer sees it. Each criterion goes to whoever can
actually check it:

| Criterion | Checked by | How |
|---|---|---|
| Leaks internals (tool names, error codes, prompt terms)? | **code** | Exact string list (`INTERNAL_TERMS`), free and exact |
| Every number / ID grounded in a tool result? | **code** | Numbers and IDs in the draft are compared with values in the trace |
| Claims an action that never ran ("I've refunded…")? | **code** | Cross-checked against successful write calls in the trace |
| Answers the actual question? | **model** | Judge prompt |
| Tone appropriate? | **model** | Judge prompt |

A draft that fails a code check is rejected **without any model call**. The judge runs
only when the code checks pass.

### Design decision: same model, or a cheaper/different one?

**Neither, as the primary answer.** A model grading its own answer is a weak check by
construction: it already decided the answer was good, which is why it wrote it.
"Reflection that always passes is not reflection." So the criteria that *can* be facts
(leaks, grounding, false claims) are taken away from any model and checked in code. The
model is left with the two criteria that need judgment, at one short call. The judge
runs on the same `callLLM` client (and fallback chain) as the agent: the same provider,
but a different prompt and role, and it only sees the draft plus tool results.
Trade-off accepted: a dedicated cheaper judge would cut cost slightly, but a different
model family would be the bigger gain against self-preference. The `model` option is
already threaded through, so it is a one-line change.

### Revision cap and persistence

- On `revise`, the failures go back to the model as a system message with specific
  instructions, and the loop produces a new draft. **`MAX_REVISIONS = 2`.** After that,
  the last draft goes out.
- **Both the verdict and the rejected draft are persisted** in `reflections[]` on the
  run: `{revision, verdict, checkedBy, failures, draft}`. That is the quality dataset:
  what a bad answer looked like and why it was rejected.
- **Visible:** the reflection panel shows each draft, its verdict, who checked it, the
  failed criteria, and the final text that was sent.

## Demonstrations

| # | Demo | How |
|---|---|---|
| 4 | Plan revised mid-execution | *"I'm alice@shop.com. Please refund my Onboarding Support Package order and confirm when it is done."* ord_1002 was delivered 115+ days ago, so `checkRefundEligibility` returns `eligible: false`, and the plan viewer shows "revised 1×" with the reason. `node tests/test-planning.js` part E |
| 5 | Reflection catches a bad draft | `node tests/test-reflection.js` part C: drafts that leak "getCustomer… issueRefund", invent "$999.00", or claim "Your refund has been processed" with no write in the trace are all rejected by code, and a good draft passes. Part D shows the full loop rejecting and rewriting a real draft. The panel shows draft vs final |
