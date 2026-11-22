# Build 1 — Single agent with tool calling

```mermaid
flowchart LR
    subgraph FE["React"]
        CHAT["Chat + live activity"]
        TV["Trace viewer"]
        CM["Confirm modal"]
        TOK["Token counter"]
    end

    subgraph API["Express"]
        RL["Rate limit<br/>Redis sliding window"]
        SSE["POST /chat/stream<br/>SSE: thinking · tool_call · tool_result · token · done"]
        CONF["POST /chat/confirm"]
    end

    subgraph CORE["agentRunner.js — the loop"]
        LOOP["callLLM → tool? → execute → append → repeat<br/>max 8 iterations · 30k tokens"]
        REG["toolRegistry<br/>schema → validate → handler<br/>never throws"]
        POL["policy.js<br/>refund ≤$100 allow · ≤$2000 approve · else refuse"]
        AUTHZ["authorization.js<br/>ownership before existence"]
    end

    subgraph DATA["Data"]
        MONGO[("MongoDB<br/>customers · orders · invoices · refunds<br/>AgentRun trace · ToolCall")]
        CHROMA[("ChromaDB<br/>policy KB + citations")]
        REDIS[("Redis<br/>rate limits")]
        LLM["Mistral<br/>(Groq fallback)"]
    end

    CHAT --> SSE --> RL --> LOOP
    CM --> CONF --> LOOP
    LOOP <--> LLM
    LOOP --> REG --> POL
    REG --> AUTHZ
    REG --> MONGO
    REG --> CHROMA
    RL --> REDIS
    LOOP -->|"finish(): every exit"| MONGO
    LOOP -->|"write tool → pause<br/>state as plain data"| CM
```

**Key properties:** the loop owns every exit (answer, cap, budget, pause). Tool errors
come back as data. Limits live in `policy.js`, not the prompt. Each run is persisted
with a `runId` and logged as JSON lines.
