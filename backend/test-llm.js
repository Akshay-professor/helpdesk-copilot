/**
 * test-llm.js — a scratch script to verify Step 1 works.
 *
 * Run it with:  node test-llm.js
 *
 * This is NOT part of the application. It exists so we can test the LLM client
 * on its own, without the web server in the way. If something breaks, we want
 * to know whether the problem is the LLM or the server — not both at once.
 */

require("dotenv").config();
const { callLLM } = require("./src/llm/llmClient");

async function main() {
  console.log("Calling Mistral...\n");

  const message = await callLLM({
    messages: [
      { role: "user", content: "Say hello and tell me you are working, in one sentence." },
    ],
  });

  console.log("Reply:", message.content);
  console.log("\nFull message object:");
  console.log(JSON.stringify(message, null, 2));
}

main().catch((err) => {
  console.error("\n FAILED:", err.message);
  process.exit(1);
});
