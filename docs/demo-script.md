# Demo Script — the 11 required demonstrations

A recording order that covers every failure path the review checks. Total about 12
minutes. **Reseed first**, because refunds accumulate and a correctly capped refund
looks exactly like a bug:

```bash
cd backend && node seed-db.js && node index-kb.js && node src/server.js
```

Keep the backend terminal visible: the JSON `run_end` / `tool_exec` log lines are part
of the evidence. Open the **trace pane** for every chat demo.

| # | Demonstration | Do this | Point at |
|---|---|---|---|
| 1 | Iteration cap → graceful stop | `node tests/test-safety.js` (part E) | `iterations used: 8`, `stoppedReason: max_iterations`, handoff reply, no crash |
| 2 | Out-of-policy refund rejected **in code** | Chat: *"refund $5000 on ord_1001"*, then `node tests/test-policy-unit.js` | Trace: `issueRefund ✗ policy_violation` and **no** confirm modal. The limit is in `policy.js` |
| 3 | Tool error → recovery | Chat: *"look up ghost@nowhere.com"* | Trace: `getCustomer ✗ customer_not_found`, and the next iteration asks for the right email instead of crashing |
| 4 | Plan revised mid-execution | Chat: *"I'm alice@shop.com. Please refund my Onboarding Support Package order and confirm when it is done."* | Plan panel: step ✗ / not eligible, **"revised 1×"**, revision reason, new steps highlighted |
| 5 | Reflection catches a bad draft | `node tests/test-reflection.js` (parts C and D) | Leaky / invented / false-action drafts **caught by code**. In the UI, the Reflection panel shows draft 1 *revise* vs final |
| 6 | Approval pause → **server restart** → approve → resume | Chat: *"I'm alice@shop.com, refund $240 on ord_1001 for the duplicate charge"* → Approvals tab shows it → **Ctrl+C the backend, restart it** → Approve | Trace after resume, refund recorded once. Then click Approve again: **409** (idempotent) |
| 7 | Approval rejected → handled | Repeat 6 with a fresh request, click **Reject** with a note | Run completes with an explanation and no refund row. Also try **Modify** → $5,000: refused by the same code |
| 8 | Routed to a workflow, not the agent | Chat: *"where is order ord_1001?"* | Activity: `routed workflow`. Trace: iteration 0, **0 tokens, ~12ms**. Costs tab: traffic split bar |
| 9 | Multi-agent request, two specialists, merged | Tick **multi-agent**. Chat: *"I'm alice@shop.com — my subscription didn't renew and I was charged anyway"* | Agents timeline: coordinator decides (usually *sequential*, account → billing), one bar per specialist, one merged reply. Costs tab: per-agent tokens |
| 10 | Research agent reports uncertainty | Research tab: *"Are customers on the Pro plan churning more than last quarter, and why?"* | Confidence **LOW** with named gaps ("couldn't determine a churn rate"). Ticket-history citations explain *why*, with the caveat that tickets can't give a rate |
| 11 | Voice call with a tool call, silence handled | Voice tab → Start call → hold: *"I'm alice@shop.com, show me my invoices"* | ~1.2s later: "Let me pull up your account." Answer spoken as sentences, not a table. Talk over it: barge-in stops playback |

**Closing shot:** run the offline suite, which is also CI.

```bash
cd backend && npm run test:offline
```
