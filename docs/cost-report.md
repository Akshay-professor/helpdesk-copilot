# Cost Report — tokens and $ per request type, all three builds

**Sources:** the 278-run route distribution (`GET /routing`, also in the README) and the
36-run architecture benchmark (`tests/test-arch-bench.js`, analysed in
[multi-agent-analysis.md](multi-agent-analysis.md)). Token counts are **measured**.

**The $ figures are derived, not billed.** A run stores one `tokensUsed` total that
mixes input and output tokens (and, for routed runs, the small classifier). So
$ = tokens × one **blended rate of $0.20 per 1M tokens**, an *assumption* in the range
of small-model pricing (Mistral Small, Groq gpt-oss-20b). Check your providers' current
price pages and re-run with your own rate. Every $ below scales linearly with it.

```bash
cd backend
COST_PER_MTOK=0.20 node cost-report.js     # regenerate from MongoDB, prints markdown
```

`cost-report.js` groups every stored run by request type (route, split by specialist)
and adds research reports. It prints avg / p50 / p95 tokens, latency, $ per request,
$ per 1k requests, plus overhead and failure-path shares: planned, reflection-revised,
iteration cap, token budget, paused. **Paste its output under "Latest generated run"
before submitting.**

---

## 1. Per request type (route) — Builds 1 → 3

| Request type | Introduced in | Share of traffic | Avg tokens | Avg latency | $ / request | $ / 1k requests |
|---|---|---|---|---|---|---|
| Workflow (deterministic, no LLM) | Build 2 | 16.9% | **0** | **12ms** | **$0** | **$0** |
| Guided agent (tool subset) | Build 2 | 43.2% | 5,286 | 7.5s | $0.00106 | $1.06 |
| Specialist (one Build 3 agent) | Build 3 | 30.2% | 6,543 | 8.4s | $0.00131 | $1.31 |
| Autonomous (all tools; the Build 1 shape) | Build 1 | 9.7% | 7,989 | 13.3s | $0.00160 | $1.60 |
| **Blended, as routed** | | 100% (278 runs) | **5,035** | | **$0.00101** | **$1.01** |
| *Counterfactual: everything autonomous* | | | *7,989* | *13.3s* | *$0.00160* | *$1.60* |

**What routing buys:** about **37% fewer tokens per request** than sending all traffic
down the autonomous path, and about 1 in 6 requests returns in 12ms for $0. Blended =
0.169×0 + 0.432×5,286 + 0.302×6,543 + 0.097×7,989.

## 2. Same questions, single agent vs multi-agent (Build 1/2 core vs Build 3)

Six request types × 3 runs × 2 architectures, same endpoint and validation.

| Case | Single: tokens | Single: $/req | Multi: tokens | Multi: $/req | Multi premium |
|---|---|---|---|---|---|
| Trivial lookup (workflow) | 0 | $0 | 0 | $0 | — |
| Single domain, read | 5,192 | $0.00104 | 8,083 | $0.00162 | +56% |
| Policy question | 3,579 | $0.00072 | 4,603 | $0.00092 | +29% |
| Needs approval | 4,077 | $0.00082 | 7,890 | $0.00158 | +94% |
| Two domains | 5,327 | $0.00107 | 8,459 | $0.00169 | +59% |
| Outside every domain | 4,904 | $0.00098 | 4,093 | $0.00082 | −17% |
| **All 18 runs each** | **3,938** | **$0.00079** | **5,500** | **$0.00110** | **+40%** |

Accuracy was 17/18 single vs 18/18 multi. **Multi-agent costs 40% more for equal
accuracy**, permanently: a coordinator call plus N specialist calls is strictly more
work than one agent call. The only case it was cheaper is the one where a specialist
correctly said "not mine" early.

## 3. Anatomy: which LLM calls happen, and which are necessary

This is the review's "this ran 6 LLM calls, which were necessary?" question. These counts follow
from the code paths, so they hold by construction:

| Call | Model | When it happens | Necessary? |
|---|---|---|---|
| Intent classifier | gpt-oss-20b (~600ms) | Only if no regex rule matched | Yes when it runs. It is skipped for most traffic because regex goes first |
| Plan classifier | reasoning model, one word | Only if the code classifier can't decide | Usually skipped |
| Plan | reasoning model | Multi-act requests only | Yes for multi-act. The threshold keeps it off single-act requests |
| Loop iterations | reasoning model | One per tool round + final answer | Yes. Each one is a decision |
| Reflection judge | reasoning model | Only after the free code checks pass | Yes, but only for relevance and tone. Leaks, grounding and false claims cost $0 |
| Revision | reasoning model | Only when reflection says revise (≤ 2) | Yes. That is the fix |
| Coordinator decide + merge | reasoning model | Multi-agent only | **The 40% premium.** Necessary only when isolation is a requirement |
| Speech rewrite | reasoning model | Voice, long/tabular answers only, **cached** | First time only, since repeats are cache hits |

**Example: "refund the duplicate and tell me why".** Guided route (regex, no classifier
call) → plan classifier (code, $0) → **plan (1)** → iterations that call getCustomer,
getInvoices, checkRefundEligibility and issueRefund (**4**, the last one pauses) → after
confirmation, **final draft (1)** → **reflection judge (1)** = **7 LLM calls** (fewer if
the model batches the reads into one parallel tool call). The removable ones are the
plan (the reactive loop handles this case, at a higher risk of skipping the eligibility
check) and the judge (the code checks already cover the dangerous failures). Everything
else is a decision only the model can make.

## 4. Research agent and voice

- **Research:** decompose (1) + parallel source reads ($0, DB/Chroma) + synthesis (1).
  So 2 LLM calls regardless of how many sources, because investigation runs in code.
  Measured tokens per report come from `cost-report.js` (`research` row).
- **Voice:** the same per-route costs as chat, plus STT (Groq Whisper, billed per audio
  second, not tokens) and the speech rewrite for long answers only. Synthesis is
  in-browser and free. A rewrite cache hit costs 0 tokens.

---

## Latest generated run

_Run `node cost-report.js` against your MongoDB and paste the output here._
