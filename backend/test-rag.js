/**
 * test-rag.js — Step 9 verification.
 *
 * Run with:  node test-rag.js
 *
 * THE TEST THAT MATTERS is Part C: the exact question from Step 2, where the
 * agent invented a 30-day policy with a fake URL while under a prompt telling
 * it not to. It must now either cite a real document or admit it cannot
 * determine the answer.
 */

require("dotenv").config();
const { connectDB, disconnectDB } = require("./src/db/connection");
const { connectVectorStore, search } = require("./src/rag/vectorStore");
const { executeTool } = require("./src/tools/toolRegistry");
const { runAgent } = require("./src/agent/agentRunner");
const { DOCUMENTS } = require("./src/data/knowledgeBase");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

async function main() {
  await connectDB();
  const kb = await connectVectorStore();
  if (!kb) {
    console.error("\nChromaDB unavailable. Run: docker start helpdesk-chroma");
    process.exit(1);
  }

  // =====================================================================
  line("A.  SEMANTIC SEARCH — meaning, not keywords");

  console.log("\n  Customer phrasing shares NO words with the document title:\n");
  const probes = [
    ["can I get my money back", "refund"],
    ["I was billed twice for one thing", "duplicate"],
    ["when does my package show up", "shipping"],
    ["I want to permanently erase my profile", "deletion"],
  ];

  for (const [q, expectWord] of probes) {
    const { results } = await search(q, 1);
    const top = results[0];
    const hit = top && top.title.toLowerCase().includes(expectWord);
    console.log(`  "${q}"`);
    console.log(`      -> ${top ? top.title : "nothing"} (${top?.score}) ${hit ? "" : "  <- unexpected"}`);
  }

  // =====================================================================
  line("B.  THE RELEVANCE FLOOR — refusing to cite an irrelevant document");

  console.log("\n  Asking something the knowledge base does not cover:\n");
  const off = await executeTool(
    "searchKnowledgeBase",
    '{"query":"what is the capital of France"}'
  );
  console.log(`  found: ${off.result.found}`);
  console.log(`  message: ${off.result.message ?? "(none)"}`);
  if (off.result.closestButBelowThreshold) {
    console.log(
      `  closest match was "${off.result.closestButBelowThreshold}" at ` +
      `${off.result.closestScore} - below the 0.65 floor, so rejected`
    );
  }
  console.log(
    `\n  ${off.result.found === 0
      ? "PASS — vector search returned something, and we refused to use it."
      : "FAIL — cited an irrelevant document."}`
  );

  // =====================================================================
  line("C.  THE STEP 2 REGRESSION — the question that started all this");

  console.log(`
  Back at Step 2 this exact question produced:

    "Our standard return policy allows returns within 30 days of purchase
     for a full refund... visit our Returns Page (example.com/returns)"

  Every word invented. No store, no policy, no such URL - and it was under a
  system prompt explicitly forbidding invented policies.
`);

  const r = await runAgent("What is your refund policy?");

  console.log("  Tools called:");
  for (const t of r.trace)
    for (const c of t.toolCalls)
      console.log(`    ${c.name} -> ${c.ok ? "ok" : c.result.error}`);

  console.log(`\n  Answer:\n`);
  console.log("  " + r.reply.split("\n").join("\n  "));

  const usedKB = r.trace.some((t) =>
    t.toolCalls.some((c) => c.name === "searchKnowledgeBase")
  );
  // Does the answer name a document we actually have?
  const titles = DOCUMENTS.map((d) => d.title);
  const cited = titles.filter((t) => r.reply.includes(t));
  const fakeUrl = /example\.com|our website|Returns Page/i.test(r.reply);

  console.log(`\n  searched the knowledge base : ${usedKB}`);
  console.log(`  cited real documents        : ${cited.length > 0 ? cited.join(", ") : "none"}`);
  console.log(`  invented a URL              : ${fakeUrl}`);
  console.log(
    `\n  ${usedKB && cited.length > 0 && !fakeUrl
      ? "PASS — grounded in real documents, with citations."
      : usedKB && !fakeUrl
        ? "PARTIAL — searched and did not invent, but cited no title explicitly."
        : "FAIL — still ungrounded."}`
  );

  // =====================================================================
  line("D.  SAYING 'I DON'T KNOW' — the behaviour the assignment requires");

  console.log(`\n  Asking a policy question we have NO document for:\n`);
  const r2 = await runAgent(
    "What is your policy on price matching against competitors?"
  );

  console.log("  Tools called:");
  for (const t of r2.trace)
    for (const c of t.toolCalls)
      console.log(`    ${c.name} -> ${c.ok ? "ok" : c.result.error}`);

  console.log(`\n  Answer:\n`);
  console.log("  " + r2.reply.split("\n").join("\n  "));

  const admits = /cannot|can't|don't have|do not have|unable|no (information|policy|record)|escalat/i.test(r2.reply);
  console.log(
    `\n  ${admits
      ? "PASS — admitted it could not determine the answer."
      : "FAIL — answered a question it has no source for."}`
  );

  // =====================================================================
  line("E.  GROUNDED + LIVE DATA IN ONE ANSWER");

  console.log(`\n  A question needing BOTH policy and the customer's records:\n`);
  const r3 = await runAgent(
    "I'm alice@shop.com. Is my Onboarding Support Package order still refundable, and what does the policy say about the time limit?"
  );

  console.log("  Tools called:");
  for (const t of r3.trace)
    for (const c of t.toolCalls)
      console.log(`    ${c.name} -> ${c.ok ? "ok" : c.result.error}`);

  console.log(`\n  Answer:\n`);
  console.log("  " + r3.reply.split("\n").join("\n  "));

  const usedBoth =
    r3.trace.some((t) => t.toolCalls.some((c) => c.name === "searchKnowledgeBase")) &&
    r3.trace.some((t) => t.toolCalls.some((c) => c.name === "checkRefundEligibility"));
  console.log(
    `\n  ${usedBoth
      ? "PASS — combined retrieved policy with live account data."
      : "PARTIAL — did not use both sources."}`
  );

  await disconnectDB();
  console.log("");
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  await disconnectDB();
  process.exit(1);
});
