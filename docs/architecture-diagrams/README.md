# Architecture diagrams — system evolution

One diagram per build. Each build adds to the previous one and replaces nothing: the
Build 1 loop is still the core in Build 3.

| Build | Diagram | What it adds |
|---|---|---|
| 1 | [build-1.md](build-1.md) | Hand-written loop, tool registry, code-enforced policy, SSE, trace |
| 2 | [build-2.md](build-2.md) | Router (workflow / guided / autonomous), planner, reflection, durable approvals |
| 3 | [build-3.md](build-3.md) | Coordinator + specialists, research agent, voice channel over the same core |

The diagrams are Mermaid, so GitHub renders them inline.
