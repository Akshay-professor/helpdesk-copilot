/**
 * The speech-rewrite cache ("TTS response caching for repeated phrases").
 * Offline: the LLM is stubbed, Redis is absent, so this exercises the
 * in-process fallback - the path that must never break a call.
 *
 *   node tests/test-speech-cache.js
 */
const assert = require("node:assert");
const llm = require("../src/llm/llmClient");

let calls = 0;
llm.callLLM = async () => {
  calls++;
  return { content: "You have three invoices. The most recent is for $240.", _usage: { total_tokens: 120 } };
};

const { formatForSpeech, cacheStats } = require("../src/voice/speechFormat");

(async () => {
  const table = "| Invoice | Order | Amount |\n|---|---|---|\n| inv_5001 | ord_1002 | $150.00 |\n| inv_5002 | ord_1001 | $240.00 |";

  const first = await formatForSpeech(table);
  assert.equal(calls, 1, "first time: one rewrite call");
  assert.equal(first.cached, undefined);
  assert.match(first.text, /240 dollars/, "mechanical pass still runs on model output");

  const second = await formatForSpeech(table);
  assert.equal(calls, 1, "repeat: served from cache, no LLM call");
  assert.equal(second.cached, true);
  assert.equal(second.tokens, 0);
  assert.equal(second.text, first.text, "same spoken text");

  await formatForSpeech(table + "\n| inv_5003 | ord_1001 | $240.00 |");
  assert.equal(calls, 2, "different text: a new rewrite");

  // Short, speakable replies never reach the model or the cache.
  await formatForSpeech("Your order has shipped.");
  assert.equal(calls, 2);

  assert.deepEqual(cacheStats, { hits: 1, misses: 2 });
  console.log("speech cache: all checks pass", cacheStats);
  process.exit(0);
})();
