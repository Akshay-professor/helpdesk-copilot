/**
 * vectorStore.js
 *
 * Talks to ChromaDB — stores documents as vectors, searches them by meaning.
 *
 * Same pattern as every other external dependency in this project: one file
 * owns the connection, everything else calls plain functions and never learns
 * that Chroma exists.
 *
 * WHEN CHROMA IS UNAVAILABLE:
 * `search()` returns an empty result rather than throwing. The tool above it
 * then tells the agent it found nothing, and the agent says it cannot determine
 * the answer — which is the CORRECT behaviour anyway.
 *
 * That is the important property: when retrieval fails, the system degrades
 * into honest ignorance, not confident invention. A RAG system whose failure
 * mode is "make something up" is worse than no RAG at all.
 */

const { ChromaClient } = require("chromadb");
const { embeddingFunction } = require("./embeddings");

const COLLECTION_NAME = "helpdesk_kb";
// Past support tickets live in their OWN collection, not as a KB category.
// The KB is policy the support agent may cite; a ticket is one customer's
// complaint. Mixing them would let the agent cite "a customer said refunds
// take a day" as policy. Only the research agent reads this one.
const TICKETS_COLLECTION = "helpdesk_tickets";

let client = null;
let collection = null;
let tickets = null;
let available = false;

/** Is the knowledge base usable right now? */
function isAvailable() {
  return available && collection !== null;
}

/**
 * Connect to ChromaDB and open (or create) our collection.
 *
 * @returns {Promise<boolean>} false if unavailable — never throws
 */
async function connectVectorStore(url = process.env.CHROMA_URL) {
  const target = url || "http://localhost:8000";

  try {
    const parsed = new URL(target);
    client = new ChromaClient({
      host: parsed.hostname,
      port: Number(parsed.port) || 8000,
      ssl: parsed.protocol === "https:",
    });

    await client.heartbeat();

    collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction,
      // Cosine similarity is the right metric for text embeddings: it compares
      // the DIRECTION of two vectors, ignoring magnitude. A long document and a
      // short question about the same topic point the same way even though
      // their magnitudes differ wildly.
      metadata: { "hnsw:space": "cosine" },
    });
    tickets = await client.getOrCreateCollection({
      name: TICKETS_COLLECTION,
      embeddingFunction,
      metadata: { "hnsw:space": "cosine" },
    });

    available = true;
    console.log("[rag] connected to ChromaDB");
    return true;
  } catch (err) {
    available = false;
    console.warn(
      `[rag] ChromaDB unavailable (${err.message}) — knowledge base search ` +
        `will return no results, and the agent will say it cannot determine ` +
        `policy answers.`
    );
    return false;
  }
}

/**
 * Load documents into the collection, replacing whatever was there.
 *
 * @param {Array<{id,title,category,text}>} documents
 */
async function indexDocuments(documents) {
  collection = await rebuild(COLLECTION_NAME, documents, (d) => ({
    title: d.title,
    category: d.category,
  }));
  return documents.length;
}

/**
 * Load past support tickets into their own collection, replacing what was there.
 *
 * @param {Array<{id,subject,plan,quarter,category,outcome,text}>} rows
 */
async function indexTickets(rows) {
  tickets = await rebuild(
    TICKETS_COLLECTION,
    rows.map((t) => ({ ...t, title: t.subject })),
    (t) => ({ title: t.subject, plan: t.plan, quarter: t.quarter, category: t.category, outcome: t.outcome })
  );
  return rows.length;
}

async function rebuild(name, docs, metaFor) {
  if (!isAvailable()) throw new Error("ChromaDB is not available.");

  // Wipe and rebuild rather than upsert. Re-indexing is cheap at this size,
  // and it guarantees a document deleted from the source actually disappears
  // from search - an upsert would leave it behind forever.
  try {
    await client.deleteCollection({ name });
  } catch {
    // Collection did not exist. Fine.
  }

  const col = await client.getOrCreateCollection({
    name,
    embeddingFunction,
    metadata: { "hnsw:space": "cosine" },
  });

  // One batched call rather than one per document: embedding APIs charge and
  // rate-limit per request.
  await col.add({
    ids: docs.map((d) => d.id),
    documents: docs.map((d) => `${d.title}\n\n${d.text}`),
    metadatas: docs.map(metaFor),
  });
  return col;
}

/**
 * Search the knowledge base by meaning.
 *
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<{available:boolean, results:Array}>}
 */
async function search(query, limit = 3, options = {}) {
  if (!isAvailable()) return { available: false, results: [] };

  try {
    // ---- Build 3: per-specialist KB slices --------------------------------
    //
    // The assignment asks each specialist agent to have its own KB collection.
    // We use ONE Chroma collection with a metadata filter rather than four
    // physical collections, because the isolation property that matters is
    // "the billing agent cannot cite the account-deletion policy" - and a
    // where-clause enforces that exactly as well as separate storage, without
    // four indexes to keep in sync.
    //
    // Chroma needs $in for a list and a bare match for one value; sending the
    // wrong shape returns everything, which would silently defeat the point.
    const categories = options.categories;
    const where =
      Array.isArray(categories) && categories.length > 0
        ? categories.length === 1
          ? { category: categories[0] }
          : { category: { "$in": categories } }
        : undefined;

    return { available: true, results: await queryCollection(collection, query, limit, where) };
  } catch (err) {
    console.error("[rag] search failed:", err.message);
    return { available: false, results: [] };
  }
}

/**
 * Search past support tickets by meaning. Research agent only.
 *
 * @returns {Promise<{available:boolean, results:Array}>}
 */
async function searchTickets(query, limit = 5) {
  if (!isAvailable() || !tickets) return { available: false, results: [] };
  try {
    return { available: true, results: await queryCollection(tickets, query, limit) };
  } catch (err) {
    console.error("[rag] ticket search failed:", err.message);
    return { available: false, results: [] };
  }
}

async function queryCollection(col, query, limit, where) {
  const res = await col.query({
    queryTexts: [query],
    nResults: limit,
    ...(where && { where }),
  });

  const ids = res.ids?.[0] ?? [];
  const docs = res.documents?.[0] ?? [];
  const metas = res.metadatas?.[0] ?? [];
  const distances = res.distances?.[0] ?? [];

  return ids.map((id, i) => ({
    id,
    ...metas[i],
    title: metas[i]?.title ?? id,
    text: docs[i],
    // Chroma returns cosine DISTANCE (0 = identical). Flip it to a
    // similarity score, which is what a human reading a trace expects.
    score: Number((1 - (distances[i] ?? 1)).toFixed(3)),
  }));
}

/** Document count, for diagnostics. */
async function count() {
  if (!isAvailable()) return 0;
  try {
    return await collection.count();
  } catch {
    return 0;
  }
}

module.exports = {
  connectVectorStore,
  indexDocuments,
  indexTickets,
  search,
  searchTickets,
  count,
  isAvailable,
  COLLECTION_NAME,
  TICKETS_COLLECTION,
};
