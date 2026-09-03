/**
 * index-kb.js — load the knowledge base into ChromaDB.
 *
 * Run with:  node index-kb.js
 *
 * Re-run this whenever you edit src/data/knowledgeBase.js. It wipes and
 * rebuilds, so a document you delete actually disappears from search.
 */

require("dotenv").config();
const { connectVectorStore, indexDocuments, search, count } = require("./src/rag/vectorStore");
const { DOCUMENTS } = require("./src/data/knowledgeBase");

async function main() {
  const ok = await connectVectorStore();
  if (!ok) {
    console.error(
      "\nCould not reach ChromaDB.\n" +
        "  docker ps                      is it running?\n" +
        "  docker start helpdesk-chroma   start it\n"
    );
    process.exit(1);
  }

  console.log(`\nIndexing ${DOCUMENTS.length} documents (embedding via Mistral)...`);
  const n = await indexDocuments(DOCUMENTS);
  console.log(`Indexed ${n}. Collection now holds ${await count()}.`);

  // A smoke test proving semantic search actually works. Every query below is
  // phrased the way a CUSTOMER would ask - deliberately using none of the words
  // in the document titles.
  console.log("\nSmoke test — customer phrasing vs document titles:\n");

  const probes = [
    "can I get my money back",
    "how long until the money shows up in my account",
    "I was charged twice for the same thing",
    "when will my stuff arrive",
    "I want to close my account permanently",
    "what is the capital of France",
  ];

  for (const q of probes) {
    const { results } = await search(q, 1);
    const top = results[0];
    console.log(`  "${q}"`);
    console.log(
      top
        ? `      -> ${top.title}  (score ${top.score})`
        : "      -> nothing found"
    );
  }

  console.log(
    "\nNote the last one. An unrelated question should score LOW - that low\n" +
    "score is what lets the tool refuse to answer instead of citing a\n" +
    "document that has nothing to do with the question.\n"
  );
}

main().catch((err) => {
  console.error("\nIndexing failed:", err.message);
  process.exit(1);
});
