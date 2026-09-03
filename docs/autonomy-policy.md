# Autonomy Policy — HelpDesk Copilot

Source: assignment PDF, "Why This Domain" section. Recorded verbatim, then
turned into the concrete numbers our code enforces.

---

## The gradient (verbatim from the assignment)

| Action | Reversible? | Should the agent do it alone? |
|---|---|---|
| Look up order status | Yes (read-only) | Yes - fully autonomous |
| Draft a reply | Yes | Yes |
| Apply a $10 account credit | Mostly | Yes, within policy limits |
| Issue a $2,400 refund | No | No - human approval required |
| Delete a customer account | No | Never - always escalate |

> "That gradient is exactly what makes human-in-the-loop, autonomy boundaries,
> and reflection real design requirements instead of textbook concepts."

## The organising principle

The axis is **reversibility**, not size.

- A $10 credit is autonomous because it is *mostly* reversible - we can claw it
  back off the account.
- A $2,400 refund needs approval because the money has left. No undo exists.
- Account deletion is never autonomous at any value, because the data is gone.

Dollar amounts are a *proxy* for reversibility, not the rule itself. This
matters when we add tools the PDF does not list: ask "can this be undone?"
first, and only then "how much?"

## Note on the numbers

The assignment gives **no exact threshold**. $10 and $2,400 are illustrations of
the two ends of the gradient, not policy values.

The `$500` that appears elsewhere in the PDF is from the safety lesson - "a
prompt saying 'never refund over $500' is a suggestion; a code check is a
guarantee" - an example of prompt-vs-code enforcement, not a stated limit.

So we choose the threshold and defend it, which is what the assignment asks for
throughout ("design and defend").

---

## Our policy (to be enforced in code at Step 5)

| Tier | Rule | Tools |
|---|---|---|
| **Autonomous** | Read-only. No limit. | `searchKnowledgeBase`, `getCustomer`, `getOrders`, `getInvoices`, `checkRefundEligibility` |
| **Autonomous, logged** | Write, within a hard cap | `applyAccountCredit` (<= $50), `issueRefund` (<= $100) |
| **Human approval** | Write, above the cap | `issueRefund` ($100.01 - $2000) |
| **Always escalate** | Never autonomous at any value | account deletion, legal/security, `issueRefund` > $2000 |

### Defending these numbers

**Credit cap $50.** The assignment calls $10 "mostly" reversible and clearly
routine. $50 stays well inside that spirit while being useful for real goodwill
gestures. Credit is recoverable from the account balance, so the ceiling can sit
above the refund ceiling.

**Refund auto-approve $100.** Refunds are irreversible, so this is deliberately
lower than the credit cap despite being the "bigger" sounding action -
reversibility, not size, is the axis. $100 covers the common
duplicate-charge case (the PDF's own worked example) without a human in the
loop, which is the point of the system.

**Approval band up to $2000.** The PDF puts $2,400 firmly in "human approval
required", so our ceiling sits below it.

**Hard refuse above $2000.** Above this, approval is not enough - it escalates.
This gives us the fourth tier the PDF's "Never - always escalate" row demands.

### Build 1 vs Build 2

Build 1 has no human-in-the-loop machinery yet. So in Build 1:

- Within cap -> execute
- Above cap  -> return a structured `policy_violation` error (NOT a thrown
  exception) so the agent can explain it and offer to escalate

Build 2 replaces that rejection with a real approval queue. The tier boundaries
above do not change - only what happens at the boundary.

---

## The worked example to build toward

The PDF's canonical test case:

> "My last invoice charged me twice - please refund the duplicate and tell me
> why it happened."

Requires, in one request: look up customer -> fetch invoice history -> identify
the duplicate -> check refund eligibility against policy -> issue the refund
(irreversible) -> explain the root cause.

That is retrieval + reasoning + policy check + side-effecting action + written
explanation. Our seed data should contain a customer with an actual duplicate
charge so this runs end to end.
