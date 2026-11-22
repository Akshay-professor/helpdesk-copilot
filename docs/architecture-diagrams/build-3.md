# Build 3 — Multi-agent, research agent, voice

```mermaid
flowchart TD
    subgraph CH["Channels"]
        CHAT["Chat · SSE"]
        VOICE["Voice · WebSocket<br/>JWT in Sec-WebSocket-Protocol"]
        RS["Research tab · SSE"]
    end

    CHAT -->|"multi-agent on"| COORD
    CHAT -->|"off"| SINGLE["single agent<br/>(Build 2 path)"]
    VOICE --> VS["VoiceSession<br/>STT · filler · barge-in · spoken confirm<br/>speech formatter + Redis cache"]
    VS --> SINGLE

    COORD["Coordinator<br/>delegation only, no domain tools<br/>MAX_DELEGATIONS=3 · MAX_DEPTH=2"]
    COORD -->|"brief, not full history"| BILL["Billing<br/>invoices · refunds · credits<br/>KB: refunds, billing, support"]
    COORD --> TECH["Technical<br/>status · logs · orders<br/>KB: shipping, support"]
    COORD --> ACC["Account<br/>profile · changePlan · reads invoices<br/>KB: accounts, billing, support"]
    BILL & TECH & ACC -->|"same runAgent() core<br/>own prompt · tool subset · KB slice"| MERGE["merge<br/>(no new facts allowed)"]
    MERGE --> OUT(["reply + per-agent cost"])

    RS --> RA["Research agent"]
    RA --> D["decompose ≤5 sub-questions"]
    D --> P["investigate in parallel<br/>Promise.all"]
    P --> S1[("Mongo aggregates")]
    P --> S2[("ChromaDB policy KB")]
    P --> S3[("ChromaDB ticket history")]
    P --> C["confidence computed in code<br/>coverage · evidence · breadth · health"]
    C --> SYN["synthesis with citations<br/>+ named gaps"]
    SYN --> RR[("ResearchReport<br/>survives close/reopen")]
```

**Isolation is the point:** a specialist never *sees* tools outside its subset, and the
KB is filtered by category in the Chroma query. Writes are isolated strictly and reads
loosely (see [multi-agent-analysis.md](../multi-agent-analysis.md)). Voice is a channel
over the same `runAgent()`, not a second implementation.
