/**
 * sources.js
 *
 * The three places a research question can get an answer from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM toolRegistry.js
 * ---------------------------------------------------------------------------
 *
 * Every tool we have built so far answers a question about ONE customer:
 * "what are Alice's orders", "what is Bob's balance". That is what a support
 * agent needs.
 *
 * A research question is about a POPULATION: "are Pro customers churning more
 * than last quarter". You cannot answer that by looking up one person, and
 * looping getCustomer over everybody would be both slow and wrong - the answer
 * lives in the aggregate, not in the rows.
 *
 * THE ANALOGY. A support agent is a bank teller: they look up your account.
 * A researcher is an economist: they ask "what is the average balance across
 * everyone, and is it falling". Same database, completely different question,
 * and the teller's tools cannot answer the economist's question no matter how
 * many times you call them.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MATTERS MOST HERE
 * ---------------------------------------------------------------------------
 *
 * Every function in this file returns its data AND a citation describing where
 * that data came from, together, in one object:
 *
 *     { source: "mongodb:orders", query: "...", rows: [...], n: 12 }
 *
 * Not two separate things that a later step has to match up.
 *
 * WHY: if the finding and its citation can be separated, they WILL get
 * separated - and a number without a source is exactly the confident
 * fabrication the assignment warns about. Making them one object means a
 * finding literally cannot be constructed without saying where it came from.
 */

const { Customer, Order, Invoice, Refund, AgentRun } = require("../db/models");
const vectorStore = require("../rag/vectorStore");

/**
 * A source result. Data and provenance travel together, always.
 *
 * `n` is deliberately included even though the caller could count `rows`
 * themselves, because the synthesis step needs to know the SAMPLE SIZE to
 * judge confidence. Three orders and three thousand orders support very
 * different claims, and the model cannot tell them apart from the rows alone.
 */
function result(source, query, rows, extra = {}) {
  return {
    source,
    query,
    rows,
    n: Array.isArray(rows) ? rows.length : rows ? 1 : 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// SOURCE 1: structured aggregation over the business database
// ---------------------------------------------------------------------------

/**
 * Order and revenue statistics, grouped by any field we support.
 *
 * Only a fixed set of groupings is allowed. This is not laziness - it is the
 * same principle as the tool registry: an aggregation pipeline built from a
 * model's free text is an injection waiting to happen. A model choosing from
 * a menu cannot write a query we did not authorise.
 */
async function orderStats({ groupBy = "status" } = {}) {
  const FIELD = {
    status: "$status",
    customer: "$customerId",
  };

  const field = FIELD[groupBy];
  if (!field) {
    return result("mongodb:orders", `groupBy=${groupBy}`, [], {
      error: `Cannot group orders by "${groupBy}". Supported: ${Object.keys(FIELD).join(", ")}.`,
    });
  }

  const rows = await Order.aggregate([
    {
      $group: {
        _id: field,
        count: { $sum: 1 },
        totalValue: { $sum: "$total" },
        totalRefunded: { $sum: "$refundedAmount" },
      },
    },
    { $sort: { count: -1 } },
  ]);

  return result(
    "mongodb:orders",
    `aggregate: group by ${groupBy}, count + sum(total) + sum(refundedAmount)`,
    rows.map((r) => ({
      [groupBy]: r._id,
      orders: r.count,
      totalValue: Number((r.totalValue ?? 0).toFixed(2)),
      totalRefunded: Number((r.totalRefunded ?? 0).toFixed(2)),
    }))
  );
}

/** Customers grouped by tier, with their credit balances. */
async function customerStats() {
  const rows = await Customer.aggregate([
    {
      $group: {
        _id: "$tier",
        customers: { $sum: 1 },
        totalCredit: { $sum: "$accountCredit" },
      },
    },
    { $sort: { customers: -1 } },
  ]);

  return result(
    "mongodb:customers",
    "aggregate: group by tier, count + sum(accountCredit)",
    rows.map((r) => ({
      tier: r._id,
      customers: r.customers,
      totalCredit: Number((r.totalCredit ?? 0).toFixed(2)),
    }))
  );
}

/**
 * Refund totals and reasons.
 *
 * Returns an EMPTY array when there are no refunds, and that is a real finding
 * rather than a failure. "There were no refunds in this period" answers a
 * question about refund rates perfectly well.
 */
async function refundStats() {
  const rows = await Refund.aggregate([
    {
      $group: {
        _id: "$reason",
        count: { $sum: 1 },
        total: { $sum: "$amount" },
      },
    },
    { $sort: { count: -1 } },
  ]);

  return result(
    "mongodb:refunds",
    "aggregate: group by reason, count + sum(amount)",
    rows.map((r) => ({
      reason: r._id ?? "(none given)",
      count: r.count,
      total: Number((r.total ?? 0).toFixed(2)),
    }))
  );
}

/**
 * Operational statistics from the agent's own run history.
 *
 * This is the richest dataset we actually have - 300+ real runs generated by
 * building and testing this system - and it answers genuinely useful questions:
 * which route is used most, what does each cost, how often do runs fail.
 *
 * Worth noticing: this data was not designed or seeded. It is EXHAUST from
 * using the system. A lot of the most valuable data in real companies is like
 * that, and the reason it is valuable is that nobody curated it into telling a
 * particular story.
 */
async function agentRunStats({ groupBy = "route" } = {}) {
  const FIELD = {
    route: "$route",
    status: "$status",
    specialist: "$specialist",
  };

  const field = FIELD[groupBy];
  if (!field) {
    return result("mongodb:agentruns", `groupBy=${groupBy}`, [], {
      error: `Cannot group runs by "${groupBy}". Supported: ${Object.keys(FIELD).join(", ")}.`,
    });
  }

  const rows = await AgentRun.aggregate([
    { $match: { [field.slice(1)]: { $ne: null } } },
    {
      $group: {
        _id: field,
        runs: { $sum: 1 },
        avgTokens: { $avg: "$tokensUsed" },
        avgDurationMs: { $avg: "$durationMs" },
        avgIterations: { $avg: "$iterations" },
      },
    },
    { $sort: { runs: -1 } },
  ]);

  return result(
    "mongodb:agentruns",
    `aggregate: group by ${groupBy}, count + avg(tokens, duration, iterations)`,
    rows.map((r) => ({
      [groupBy]: r._id,
      runs: r.runs,
      avgTokens: Math.round(r.avgTokens ?? 0),
      avgDurationMs: Math.round(r.avgDurationMs ?? 0),
      avgIterations: Number((r.avgIterations ?? 0).toFixed(1)),
    }))
  );
}

// ---------------------------------------------------------------------------
// SOURCE 2: vector search over the knowledge base
// ---------------------------------------------------------------------------

/**
 * Semantic search across policy documents.
 *
 * Note it returns the SCORE alongside each hit. The synthesis step needs it:
 * a document matching at 0.71 supports a much weaker claim than one matching
 * at 0.94, and hiding that distinction is how a weak match gets reported as a
 * fact.
 */
async function searchDocs({ query, limit = 4 }) {
  const { available, results } = await vectorStore.search(query, limit);

  if (!available) {
    return result("chromadb:knowledge_base", query, [], {
      error: "The knowledge base could not be reached, so this source is missing.",
    });
  }

  return result(
    "chromadb:knowledge_base",
    query,
    results.map((r) => ({ title: r.title, score: r.score, text: r.text }))
  );
}

// ---------------------------------------------------------------------------
// SOURCE 3: the raw records, for questions the aggregates cannot answer
// ---------------------------------------------------------------------------

/**
 * A sample of raw rows.
 *
 * Capped at 20 deliberately. An unbounded read would blow the context window
 * on a large database, and 20 rows is enough to spot a pattern or notice that
 * there is no pattern to spot.
 */
async function sampleRecords({ collection, limit = 10 }) {
  const MODELS = {
    customers: Customer,
    orders: Order,
    invoices: Invoice,
    refunds: Refund,
  };

  const Model = MODELS[collection];
  if (!Model) {
    return result(`mongodb:${collection}`, "sample", [], {
      error: `No collection named "${collection}". Available: ${Object.keys(MODELS).join(", ")}.`,
    });
  }

  const capped = Math.min(Number(limit) || 10, 20);
  const rows = await Model.find({}).limit(capped).lean();

  return result(
    `mongodb:${collection}`,
    `sample up to ${capped} records`,
    rows.map((r) => {
      const { _id, __v, createdAt, updatedAt, ...rest } = r;
      return rest;
    })
  );
}

// ---------------------------------------------------------------------------
// The registry the research agent picks from
// ---------------------------------------------------------------------------

/**
 * Same pattern as the tool registry, for the same reason: adding a new data
 * source should be one entry here and zero changes to the agent that uses it.
 */
const SOURCES = {
  orderStats: {
    fn: orderStats,
    description:
      "Order counts, total value and total refunded, grouped by 'status' or 'customer'.",
    args: { groupBy: "status | customer" },
  },
  customerStats: {
    fn: customerStats,
    description: "Customer counts and account credit, grouped by tier.",
    args: {},
  },
  refundStats: {
    fn: refundStats,
    description: "Refund counts and totals, grouped by reason.",
    args: {},
  },
  agentRunStats: {
    fn: agentRunStats,
    description:
      "Operational stats from the agent's own history: runs, tokens, duration. " +
      "Group by 'route', 'status' or 'specialist'.",
    args: { groupBy: "route | status | specialist" },
  },
  searchDocs: {
    fn: searchDocs,
    description: "Semantic search across company policy documents.",
    args: { query: "what to search for", limit: "1-8" },
  },
  sampleRecords: {
    fn: sampleRecords,
    description:
      "Raw records from 'customers', 'orders', 'invoices' or 'refunds' (max 20).",
    args: { collection: "customers | orders | invoices | refunds", limit: "1-20" },
  },
};

/**
 * Run one source. Never throws - a dead source is a GAP in the report, not a
 * crashed investigation.
 *
 * This is the same lesson as the tool registry and the specialist containment
 * layer: when one part of a multi-part job fails, the rest of the job still has
 * value. The failure has to become information rather than an exception.
 */
async function runSource(name, args = {}) {
  const source = SOURCES[name];
  if (!source) {
    return result(`unknown:${name}`, JSON.stringify(args), [], {
      error: `No source named "${name}". Available: ${Object.keys(SOURCES).join(", ")}.`,
    });
  }

  try {
    return await source.fn(args);
  } catch (err) {
    console.error(`[research] source ${name} failed:`, err.message);
    return result(`error:${name}`, JSON.stringify(args), [], {
      error: `The ${name} source failed: ${err.message}`,
    });
  }
}

function describeSources() {
  return Object.entries(SOURCES).map(([name, s]) => ({
    name,
    description: s.description,
    args: s.args,
  }));
}

module.exports = { SOURCES, runSource, describeSources };
