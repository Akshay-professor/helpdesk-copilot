/**
 * embeddings.js
 *
 * Turns text into vectors.
 *
 * WHAT AN EMBEDDING IS:
 * A list of numbers representing the MEANING of a piece of text. Similar
 * meanings produce similar lists, even with no words in common. We measured it:
 *
 *   similarity("refund policy", "can I get my money back") = 0.757
 *
 * Those two phrases share zero words. Keyword search scores them 0. That gap is
 * the entire reason vector search exists — a customer will never phrase their
 * question the way your documentation is titled.
 *
 * WHY THIS IS ITS OWN FILE:
 * Same reason llmClient.js is: it is the only thing that knows we use Mistral
 * for embeddings. Swapping to a local model later (@chroma-core/default-embed)
 * or to OpenAI means rewriting this file and re-indexing. Nothing else changes.
 *
 * THE DEPLOYMENT TRADE-OFF WE CHOSE:
 *   API embeddings  -> no RAM cost, deploys to free tiers, needs network,
 *                      pennies per month at our volume
 *   Local model     -> free per query, works offline, but ~400MB RAM and slow
 *                      cold starts, so it needs paid hosting
 * At our volume (a dozen documents, occasional searches) the API wins clearly.
 * At high query volume the answer flips.
 */

const MISTRAL_EMBED_URL = "https://api.mistral.ai/v1/embeddings";
const EMBED_MODEL = "mistral-embed";

/** Mistral's embedding dimension. Chroma needs consistency, not this number. */
const DIMENSIONS = 1024;

/**
 * Embed one or more strings.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>} one vector per input, in the same order
 */
async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not set — cannot generate embeddings.");
  }

  const response = await fetch(MISTRAL_EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mistral embeddings error ${response.status}: ${body}`);
  }

  const data = await response.json();

  // The API returns results with an `index`, and we must not assume they come
  // back in request order. Sorting makes the guarantee explicit rather than
  // hoped-for.
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Chroma expects an object with a `generate` method. This adapts our function
 * to that shape, so the Chroma client never learns which provider we use.
 */
const embeddingFunction = {
  generate: async (texts) => embed(texts),
};

module.exports = { embed, embeddingFunction, DIMENSIONS, EMBED_MODEL };
