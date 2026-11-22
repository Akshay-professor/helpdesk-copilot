# Build 2 — Planning, reflection, human-in-the-loop, routing

```mermaid
flowchart TD
    REQ(["request"]) --> SCOPE{"scope guard<br/>0 tokens"}
    SCOPE -->|"off-topic"| REF["refusal"]
    SCOPE --> ROUTER{"router.js<br/>ordered rules"}
    ROUTER -->|"regex: 'where is ord_1001'"| WF["WORKFLOW<br/>lookup + template · 0 tokens"]
    ROUTER -->|"known category"| GU["GUIDED<br/>tool subset"]
    ROUTER -->|"unclear"| IC{"intent classifier<br/>Groq · ~600ms"}
    IC --> GU
    IC -->|"novel"| AU["AUTONOMOUS<br/>all tools"]

    GU --> CLS{"needs a plan?<br/>code first, LLM if unsure"}
    AU --> CLS
    CLS -->|"multi-act"| PLAN["planner<br/>steps shown + persisted"]
    CLS -->|"single act"| LOOP
    PLAN --> LOOP["Build 1 loop"]
    LOOP -->|"unexpected result"| REPLAN["revisePlan ≤2"] --> LOOP
    LOOP -->|"draft"| REFL{"reflection<br/>code: leaks · grounding · false actions<br/>model: relevance · tone"}
    REFL -->|"revise ≤2<br/>draft + verdict persisted"| LOOP
    REFL -->|"pass"| OUT(["answer"])

    LOOP -->|"write > threshold"| PAUSE[["AgentRun awaiting_confirmation<br/>MongoDB"]]
    PAUSE --> Q["Operator queue<br/>Approve · Reject · Modify"]
    Q -->|"atomic claim<br/>findOneAndUpdate → 409 on repeat"| RES["resumeAgent()<br/>any server, after restart"]
    RES --> LOOP
    PAUSE -->|"24h sweep"| EXP["expired · never auto-approved"]
```

**What lives where:** MongoDB has anything whose loss would cause wrong behavior
(paused runs, approvals, traces). Redis has hot, fine-to-lose counters (rate limits,
token budgets). The client holds the conversation, so the server is stateless between
turns. See [hitl-design.md](../hitl-design.md).
