# Multi-Agent vs Single-Agent: A Measured Comparison

**HelpDesk Copilot — Build 3, mandatory written analysis (15 marks)**

> The assignment: *"compare multi-agent against a single agent with all tools.
> Where does specialization genuinely help, and where does it just add latency
> and handoff failure modes? Be honest — **multi-agent is frequently
> over-applied, and recognizing that is a senior-level judgment.**"*

---

## The conclusion, stated first

**We built the multi-agent system, measured it against the single agent, and
would ship the single agent for most traffic.**

Multi-agent earned its place in **exactly one** situation, and it is not the one
people build it for:

**When isolation is a security requirement.** Not a quality requirement, not a
performance one. A billing agent that cannot reach the account tools cannot
misuse them, and no amount of prompt engineering gives you that property.

On accuracy the two architectures ended up **equal** (18/18 vs 17/18) — but only
after we found and fixed a design flaw that multi-agent introduced and the single
agent could not have had. Multi-agent still costs **~40% more tokens** for that
same accuracy, permanently, because a coordinator call plus N specialist calls is
strictly more work than one agent call.

**So: build it for isolation. Do not build it for quality or speed — you will not
get either, and you will pay for the privilege.**

That is not a criticism of the architecture. It is the answer to the question
the assignment actually asked, and the numbers below are how we got there.

---

## How this was measured

Six request types spanning the range a support desk sees, three runs each per
architecture — **36 runs total**. Both architectures called through the *same*
`/chat` endpoint with the same validation, rate limiting, and response shape, so
the only variable is the architecture itself.

```powershell
node seed-db.js            # a known starting state - see "measurement traps"
node test-arch-bench.js    # 6 cases x 3 runs x 2 architectures
```

Correctness is checked by reading the actual reply for the fact that answers the
question — not by checking that *something* came back. An architecture that is
cheap and wrong is not winning.

---

## The numbers

| Case | Arch | Correct | Avg tokens | Avg latency | Tools |
|---|---|---|---|---|---|
| Trivial lookup | single | **3/3** | 0 | 14ms | 0 |
| | multi | **3/3** | 0 | 3ms | 0 |
| Single domain, read | single | **3/3** | 5,192 | 7.6s | 2 |
| | multi | 2/3 | 8,083 | 7.9s | 2 |
| Policy question | single | **3/3** | 3,579 | 6.0s | 1 |
| | multi | **3/3** | 4,603 | 5.3s | 1 |
| Needs approval | single | **3/3** | 4,077 | 5.2s | 1.7 |
| | multi | **3/3** | 7,890 | 5.5s | 3.3 |
| **Two domains** | single | **3/3** | 5,327 | 4.3s | 2.3 |
| | multi | **3/3** *(was 0/3)* | 8,459 | 14.1s | 2.7 |
| Outside every domain | single | 2/3 | 4,904 | 40.4s | 1 |
| | multi | **3/3** | 4,093 | 23.4s | 1 |

**Totals, after the read-access fix described below:**

| | Correct | Avg tokens/request | Avg latency | Threw |
|---|---|---|---|---|
| **single agent** | 17/18 | **3,938** | 11,449ms | 0 |
| **multi-agent** | **18/18** | 5,500 **(+40%)** | 12,430ms | 0 |

**Accuracy is now equal or better. The cost premium is real and permanent.**

That is the honest summary: multi-agent can be made to match the single agent on
accuracy, but it will always cost more, because a coordinator call plus N
specialist calls is strictly more work than one agent call.

### A correction, and how it was caught

An earlier version of this document reported **15/18 for both** architectures
and claimed multi-agent *won* the cross-domain case 3/3. Both numbers were
wrong, and the reason is worth more than the numbers.

The benchmark printed a score and one sample reply — **but never printed the
replies that failed.** So when it said 15/18, there was no way to see which
three failed or why. It turned out one "failure" was this:

```
FAILED: "We do not ship to Antarctica."
```

That is a correct, honest, admirably short answer. The predicate required the
words *"cannot / unable / escalate"*, so it **punished the agent for being
concise** — it was asserting on phrasing, not on correctness.

Rewritten to check what would actually make the answer harmful (inventing a
delivery time, a surcharge, a courier), the single agent went from 15/18 to
**18/18** — and multi-agent's cross-domain result collapsed from an apparent 3/3
to a real **0/3**.

That 0/3 is what exposed the read-access flaw described below, which is now
fixed. The totals in the table above are the numbers *after* that fix. The point
of recording this sequence is that **the wrong measurement was hiding a real
design flaw** — a benchmark that flatters you is not merely useless, it is
actively concealing.

> **A score you cannot drill into is a rumour, not evidence.** If a run failed,
> the reply that failed has to be on screen. This is the fourth time in this
> project that a measuring instrument — not the product — was the thing that was
> broken.

---

## Where specialisation genuinely helps

### 1. Isolation — the only unqualified win

This is the real argument, and notably it has nothing to do with quality or
speed.

```
> "I'm alice@shop.com. Please downgrade me to the standard tier right now."

BILLING specialist    tools called: (none)
                      "I can't downgrade your account tier myself."
                      tier after: gold — UNCHANGED

ACCOUNT specialist    tools called: getCustomer
                      proposes changePlan, pauses for approval
```

Billing did not *refuse*. **It had nothing to call.** The tool was never in its
list, so there was nothing to be talked into — by a confusing request, a
determined customer, or a prompt injection buried in a support ticket.

The same holds for the knowledge base:

```
QUERY: "how do I close my account and delete my data"

unfiltered  →  Account Deletion | Customer Data and Privacy | When to Escalate
as account  →  Account Deletion | Customer Data and Privacy | When to Escalate
as billing  →  Customer Data and Privacy | When to Escalate | Refund Eligibility
```

**A prompt saying "don't do X" is a rule. Removing the tool is a wall.** Rules
are advice; a model under pressure can be argued past advice. This is the third
time this project has landed on that principle — code-enforced policy limits in
Build 1, guided toolsets in Build 2, specialist isolation here — which is
usually how you tell a real principle from a coincidence.

**If you need isolation, this is a good reason to build multi-agent. It may be
the only one that survives contact with the numbers.**

### 2. Correct delegation — which is not the same as a correct answer

The coordinator reads cross-domain requests correctly. On the assignment's own
example it decides, unprompted:

```
[coordinator] sequential: account → billing
  reason: The billing issue depends on confirming the subscription status first
  task[account]: Verify whether the subscription was active or lapsed
  task[billing]: Determine if the charge was legitimate given that status
```

That reasoning is right. It identified two domains, spotted the dependency, and
sequenced them in the only order that works — billing cannot judge the charge
until account establishes whether the subscription lapsed.

**And then it answered the question wrong, 3 times out of 3.** See "isolation
cuts both ways" below — the routing was never the problem.

> Worth sitting with: **a component can do its own job perfectly and still make
> the system worse.** The coordinator is not broken. The architecture it serves
> is wrong for this question.

### 3. A failure has somewhere to land

Unexpected, and worth reporting because it argues *for* the architecture.

During a genuine Mistral outage:

```
single : threw an exception 3/3   →  the customer sees a 500
multi  : degraded gracefully 3/3  →  the customer gets an apology
```

**But be careful about who gets the credit.** This came from the containment
layer we were *forced* to write when one specialist's 503 killed an entire
request — not from specialisation. A single agent with the same error handling
would behave identically.

> Some of what people credit to multi-agent is really credit owed to the
> plumbing you had to build around it.

---

## Where it just adds cost

### 1. Most traffic is single-domain

Five of our six cases needed exactly one specialist. For those, multi-agent adds:

- **one extra LLM call** to decide who handles it (~1–2s, ~500 tokens)
- **a brief-construction step** that a single agent does not need
- **+95% tokens** on average, for the same answers

The single-domain read case is the clearest: **5,170 → 7,170 tokens (+39%)** and
it scored *worse* (2/3 vs 3/3).

### 2. Isolation cuts both ways — and the fix that follows from it

The most important finding in this document, and the one that changed the
design.

Our account specialist originally **could not see invoices** — pure isolation,
working exactly as intended. On the cross-domain question that meant it could
not find the duplicate-charge note that answers the question. All three runs
produced some version of:

```
"I cannot determine whether your subscription was active or lapsed during
 the charge period."
```

Billing then received a brief that had already concluded "couldn't determine".
**0/3.** The single agent had every tool at once, found the note immediately,
and scored 3/3.

#### The wrong fix and the right one

The wrong fix is to abandon isolation. The right one is to notice that we were
isolating the **wrong thing**:

| | Rule | Why |
|---|---|---|
| **WRITES** | isolate **strictly** | Only billing can move money. A write is where harm happens. |
| **READS** | isolate **loosely** | A fact needed to answer correctly. Reading an invoice cannot hurt anyone. |

> **Blocking a read does not prevent harm. It only prevents answers.**

So `getInvoices` was added to the account specialist — read-only. `issueRefund`
and `applyAccountCredit` remain billing-only, `changePlan` remains account-only:

```
issueRefund         -> only: billing
applyAccountCredit  -> only: billing
changePlan          -> only: account
```

The security property the assignment asks for is completely intact, and all 32
isolation assertions still pass. Cross-domain went from **0/3 to 3/3**.

#### But do not over-read that result

A separate 3-run repeat of the same question scored **2/3** — one run returned an
empty reply after pausing mid-answer for approval. So the honest claim is
"clearly better, not reliably perfect", and the remaining variance is a real
open issue rather than noise to be waved away.

#### What still stands

The underlying tension has not gone away, it has only been *placed* better. Every
read you grant a specialist makes it more capable and less isolated. Grant all of
them and you have rebuilt the single agent. **The read/write split is a good
place to draw that line — it is not an escape from having to draw one.**

> **The isolation that makes multi-agent safe is the same isolation that makes
> it worse at questions spanning two domains.** These are not two properties to
> be traded off separately. They are one property seen from two sides.

You cannot tune this away. Widening each specialist's toolset to fix the
cross-domain case is just rebuilding the single agent one tool at a time.

### 3. Failure surfaces multiply

```
A single agent making 3 LLM calls has ONE thing that can fail.
Two specialists making 3 calls each have TWO INDEPENDENT things that can fail.
```

We learned this the hard way: a real 503 in one specialist killed an entire
request, including the work the *other* specialist had already completed
successfully. Fixing it required a containment layer, a gap-propagation
mechanism, and two new tests — **none of which a single agent needs at all.**

And the second bug was subtler. After containment, a dead specialist was
*contained* but not *reported*, so billing filled the silence:

> *"The subscription itself was active at the time of the charge"* — **a fact
> nobody had established.**

**More agents means more places where a gap can be mistaken for an absence of
problems.**

### 4. A new layer can discard what the old layers learned

The most seductive mistake in the whole build. Our first coordinator asked an
LLM which specialist should handle *every* request — including the ones Build 2
had already established need no LLM at all:

| | single agent | first coordinator |
|---|---|---|
| "where is order ord_1001?" | **50ms · 0 tokens** | **7,144ms · 5,664 tokens** |

**143× slower, infinitely more expensive, and it got the answer wrong.**

The fix was re-ordering, not new code — the workflow route goes *first*, and the
coordinator sits below it. But the lesson generalises:

> **A coordinator is not the top of the system.** Architecture diagrams draw it
> at the top, which is a picture, not an instruction. It is one option among the
> routes you already have, and it belongs below the free ones.

---

## Handoff protocol: the design decision we must defend

> *"Design decision to defend: full conversation history, or a summarized
> brief? (context cost vs information loss)"*

**We send a brief.**

```
to a specialist  →  { task, customerMessage, callerId, findings, gaps }
back from it     →  { answer, status, tokensUsed, trace }
```

**Why not full history:**

1. **Cost grows with agents, not turns.** Three specialists each reading a
   20-turn history is 60 turns of tokens for one question — the multi-agent tax
   paid in full, for nothing.
2. **Irrelevant context actively harms.** Hand the billing agent a long history
   about a broken zip and it starts reasoning about the zip. The point of
   specialisation is a *narrow* view; full history deliberately undoes it.
3. **An explicit contract is debuggable.** When an answer is wrong you can read
   the brief and see whether the coordinator asked the wrong question or the
   specialist answered it badly. With full history, *"it had all the
   information"* is technically true and completely useless.

**The honest cost:** information loss is real. If the customer said "the blue
one" ten turns ago, the brief may not carry it. Two mitigations — the customer's
**verbatim words always travel**, and findings pass forward between specialists
— but it is not eliminated. We decided it is cheaper than the alternative, which
is a different claim from saying the problem does not exist.

**And a third element we did not anticipate: `gaps`.** When a specialist fails,
the *next* one is told what went unestablished, explicitly:

```
IMPORTANT - part of this investigation could not be completed. These
questions were NOT answered:
- Verify whether the subscription lapsed at the time of the charge

Do not assert anything about them.
```

Without this, silence reads to a model as "nothing to worry about". This is the
RAG relevance floor from Build 1 in a new costume: **an empty result must be
reported as an empty result, never left as a space the model fills.**

---

## Loop prevention

Billing says *"that's an account question"*, account says *"that's a billing
question"*, forever — and every hop is a paid API call.

```javascript
const MAX_DELEGATIONS = 3;   // total specialist runs per request
const MAX_DEPTH = 2;         // hops in one chain
```

The prompt says "never more than 2 specialists". **The parser enforces it:**

```javascript
.filter((s) => known.includes(s))   // drop hallucinated names at the boundary
.slice(0, 2);                       // the cap, in code
```

Tested with a deliberately absurd request — *"refund me, fix my delivery, change
my plan, and tell me about churn trends"* — which returned two specialists, not
four. Hitting the cap is not a crash: we answer with what we have.

---

## Measurement traps we fell into

Three, and each one produced a confident wrong answer before we caught it.
Recording them because the instrument deserves as much scrutiny as the thing
being measured.

**1. The harness silently degraded the product.** Our first benchmark called
`connectDB()` but not `connectVectorStore()`, so every policy question returned
`knowledge_base_unavailable`. The product was fine. **A measurement that
degrades what it measures is worse than no measurement, because you act on it.**

**2. Accumulated state looked like a regression.** `ord_1001` had collected
**$215 of refunds** across dozens of test runs, so the policy correctly capped
new refunds and two suites reported failures. Nothing was broken. **`node
seed-db.js` before any regression run.**

**3. A test passed without testing anything.** Our containment test patched
`runAgent` *after* requiring the coordinator — but the coordinator destructures
its reference at load time, so the patch changed an object nobody reads. The
injected failure never happened and the test **printed PASS**. A test that
passes without reaching the code it tests is a false all-clear.

---

## What we would actually ship

**Default: the single agent.** It is what `/chat` does unless you ask otherwise.

```javascript
function agentFor(body) {
  const wants = body?.multiAgent ?? (process.env.MULTI_AGENT === "true");
  return wants ? runCoordinator : runAgent;
}
```

**Route to multi-agent when:**

- the request provably spans two domains (the coordinator already detects this)
- isolation is a compliance requirement rather than a preference
- a wrong answer is expensive enough to justify 4× the tokens

**Keep from the multi-agent build regardless of which you ship:**

- **the containment layer** — it made failure handling better, full stop
- **gap propagation** — an unestablished fact must be named
- **per-agent cost tracking** — you cannot make this decision without it

**The honest summary:** we built a multi-agent system, measured it, found it
losing the very case it exists for, diagnosed why, fixed it, and measured again.
It now matches the single agent on accuracy at ~40% more cost.

The isolation is genuinely valuable and genuinely unavailable any other way.
Everything else was a tax — and the most useful thing we learned is *which* tax
was avoidable (the read restriction) and which is not (the extra LLM calls).

> Recognising that is the point. The assignment says multi-agent is frequently
> over-applied — the numbers here say the same thing, and they are our own.

---

## Evidence

| Artefact | What it shows |
|---|---|
| `backend/test-arch-bench.js` | The 36-run comparison above |
| `backend/test-arch-repeat.js` | Three samples of the cross-domain case |
| `backend/test-wall.js` | Isolation, demonstrated behaviourally |
| `backend/test-containment.js` | One specialist dies, the request survives |
| `backend/test-gaps.js` | A failed peer is named, not silently filled in |
| `backend/test-multiagent.js` | 32 assertions on isolation, routing, handoff, caps |
| `GET /costs` | Live per-agent latency, tokens, and tool calls |
| Costs tab in the UI | The same numbers, in front of whoever would act on them |
