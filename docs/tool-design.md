# Tool Design and Safety Rails — Build 1

**Code:** `backend/src/tools/toolRegistry.js` · `backend/src/policy/policy.js` · `backend/src/policy/authorization.js`

---

## Registry pattern

A tool is one entry in `TOOLS`: `description`, a JSON-schema `parameters`, a
`handler`, and for writes `write: true` plus `summarize()`. The loop never names a
tool. `getToolDefinitions()` translates the registry into the provider's format, and
`isWriteTool()` decides whether to pause. **Adding a tool touches zero lines of the
loop.** `getSystemStatus` and `lookupLogs` were added to the Technical specialist this
way.

## The 11 tools

| Tool | Type | Notes |
|---|---|---|
| `searchKnowledgeBase(query)` | Read | ChromaDB. Relevance floor, filtered to the caller's KB slice (Build 3) |
| `getCustomer(email)` | Read | Ownership-checked |
| `getOrders(customerId, limit)` | Read | `limit` 1–50 |
| `getInvoices(customerId)` | Read | Flags `possibleDuplicates` (same order, same amount, same day) |
| `checkRefundEligibility(orderId)` | Read + logic | **The policy decides eligibility, not the model**: 30-day window, `delivered` only, already-refunded amount |
| `issueRefund(orderId, amount, reason)` | **Write, irreversible** | Tiered limits in code (below) |
| `applyAccountCredit(customerId, amount)` | Write | Tiered limits in code |
| `changePlan(customerId, tier)` | Write | Account specialist only |
| `escalateToHuman(reason, priority)` | Write | Creates a queue entry. Reason must be at least 10 characters so a human gets context |
| `getSystemStatus(component?)` | Read | Technical specialist: platform health and known incidents |
| `lookupLogs(customerId, service?, ref?, limit?)` | Read | Technical specialist: root-cause logs. Ownership-checked |

## Never trust model arguments

`executeTool(name, rawArgs, ctx)` **never throws**. In order:

1. Unknown tool → `unknown_tool`
2. `JSON.parse` fails → `invalid_json`
3. `validateArgs(schema, args)` → `invalid_arguments` with a `problems[]` list. It checks:
   required fields, unexpected fields (`additionalProperties: false`), types, integers,
   `minimum`/`maximum`, and **`enum`**. The enum check is shared, so every tool gets it.
4. The handler runs inside `try/catch` → `tool_execution_failed`
5. The handler's own domain errors: `customer_not_found`, `order_not_found`,
   `not_authorized`, `not_eligible`, `amount_exceeds_refundable`, `policy_violation`,
   `approval_required`…

Every error has the shape `{ error: "<code>", message: "<sentence the model can act on>", details? }`.
The message is written **for the model**. For example `not_authorized` says *"Ask the
customer to confirm the email address on their account, and do not guess it."*
Test: `tests/test-agent.js`, `tests/test-safety.js` part C.

## Safety rails

### 1. Hard limits in code, not in the prompt

`policy.js → checkRefundAmount()` is called **first thing inside `issueRefund`**,
before the order is even looked up:

| Refund amount | Tier | Result |
|---|---|---|
| ≤ $0, NaN, Infinity, non-number | refuse | `policy_violation`. Garbage is never compared (`NaN > 100` is `false`, which would otherwise *allow*) |
| ≤ **$100** | allow | Customer confirms, then it executes |
| $100.01 – **$2,000** | needs approval | Operator queue (Build 2). Without the operator's `ctx.approved` badge, the handler returns `approval_required` |
| > **$2,000** | refuse | `policy_violation` + escalate. **No human can approve it in this system** |

Credit: ≤ $50 allow, ≤ $500 approval. `LIMITS.neverAutonomous` (deleteAccount,
changePaymentMethod, …) exists so a future tool with those names cannot default to
allowed.

> Remove every line about refunds from the system prompt and a $5,000 refund is still
> refused. That is the test: `tests/test-policy-unit.js` (pure function, runs in CI) and
> `tests/test-safety.js` part B (every boundary, called directly) and part D (the real agent under social-engineering pressure).

An operator who **modifies** an amount goes through the same `executeTool`. Editing
$240 to $5,000 is refused by the same code. Approval changes *who asked*, never *what
is allowed*.

### 2. Confirmation before any write

`isWriteTool()` makes the loop return `awaiting_confirmation` **before** the handler
runs. `describeToolCall()` validates the arguments first, so nobody is asked to approve
a call that would fail anyway. It then builds a plain-English summary (`"Refund $55.00
for order ord_1001"`, irreversible: true, warning). The frontend shows `ConfirmModal`.
It has no default button, and the operator can edit the amount.

### 3. Authorization (ownership)

Every customer-data tool calls `requireOwnership(ctx, ownerId)` **before** checking that
the record exists. Checking existence first would turn the tool into an oracle (probe
IDs and watch "not found" vs "not authorized"). The caller comes from the request
(`x-caller-id`, or the voice JWT `sub`), never from the conversation. The model can
claim to be anyone, but the guard doesn't read the conversation. Test: `tests/test-authz.js`.

### 4. Grounding with citations

The system prompt makes `searchKnowledgeBase` mandatory for any policy question and
asks for the document title to be cited. In code, `searchKnowledgeBase` applies a
**relevance floor** (cosine similarity 0.65): below it, the tool returns "nothing relevant" instead of the
nearest document, and the prompt says to admit it doesn't know rather than fill the
gap. Reflection (Build 2) then checks that numbers in the draft appear in tool results.
Test: `tests/test-rag.js`.

## Demonstration 2: out-of-policy refund rejected at code level

```bash
cd backend && node tests/test-policy-unit.js   # boundary table, no LLM
node tests/test-safety.js                      # B: every boundary · D: the agent is talked at, the code refuses
```

In chat: *"refund $5000 on ord_1001"*. The trace shows `issueRefund ✗ policy_violation`
with no confirmation modal, because a call that is refused outright is never offered
for approval.
