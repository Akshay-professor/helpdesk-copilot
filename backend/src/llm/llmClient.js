/**
 * llmClient.js
 *
 * The ONLY file in this project that talks to the LLM provider.
 *
 * Everything else (the agent loop, the tools) goes through this file. That way,
 * if we ever switch providers, this is the single file we rewrite.
 *
 * We deliberately use plain `fetch` instead of an SDK so that the raw request
 * and response stay visible. Understanding that JSON is the whole point of the
 * assignment.
 */

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MODEL = "mistral-small-latest";

/**
 * Send a conversation to the LLM and get its reply.
 *
 * @param {Object}   options
 * @param {Array}    options.messages - The conversation so far. Each item looks
 *                                      like { role: "user", content: "hello" }.
 *                                      Roles: "system" | "user" | "assistant" | "tool"
 * @param {Array}    [options.tools]  - Tool definitions. Unused until Step 3.
 * @param {string}   [options.model]  - Override the default model.
 *
 * @returns {Promise<Object>} The assistant's message object, e.g.
 *                            { role: "assistant", content: "Hi there!" }
 *                            Later it may also carry a `tool_calls` array.
 */
async function callLLM({ messages, tools, model = DEFAULT_MODEL }) {
  const apiKey = process.env.MISTRAL_API_KEY;

  // Fail early with a clear message. A missing key is the #1 setup mistake,
  // and the API's own 401 error is much harder to understand than this.
  if (!apiKey) {
    throw new Error(
      "MISTRAL_API_KEY is not set. Add it to backend/.env — see progress.md."
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("callLLM requires a non-empty `messages` array.");
  }

  const body = { model, messages };

  // Only send `tools` if we actually have some. Sending an empty array
  // confuses some providers, so we leave the key out entirely.
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto"; // let the model decide whether to call a tool
  }

  // ---- RETRY ON TRANSIENT FAILURES --------------------------------------
  //
  // Added after a real incident: Mistral returned
  //
  //     503 "Service temporarily unavailable due to high load, please retry"
  //
  // and the customer got a 502. Their own error message says "please retry"
  // and we did not.
  //
  // Which errors deserve a retry is the whole question:
  //
  //   429, 500, 502, 503, 504  ->  RETRY. Transient. The same request will
  //                                probably work in a moment.
  //   400, 401, 403, 404       ->  DO NOT. A bad key or a malformed request
  //                                will fail identically forever; retrying
  //                                just makes the user wait three times as
  //                                long for the same error.
  //
  // Exponential backoff (0.5s, 1s, 2s) rather than a fixed delay: if the
  // service is overloaded, everyone retrying at the same instant makes it
  // worse. Spreading the retries out is how you avoid being part of the
  // problem you are recovering from.
  const RETRYABLE = [429, 500, 502, 503, 504];
  const MAX_ATTEMPTS = 3;

  let response;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      // fetch does NOT throw on 4xx/5xx — it only throws if the network itself
      // failed. So we have to check the status ourselves.
      if (response.ok) break;

      const errorText = await response.text();
      lastError = new Error(`Mistral API error ${response.status}: ${errorText}`);

      if (!RETRYABLE.includes(response.status) || attempt === MAX_ATTEMPTS) {
        throw lastError;
      }

      const waitMs = 500 * 2 ** (attempt - 1);
      console.warn(
        `[llm] ${response.status} from Mistral, retrying in ${waitMs}ms ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS})`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      // A genuine network failure (DNS, connection refused) also lands here.
      // Same reasoning: retry it, because it is usually transient.
      lastError = err;
      if (attempt === MAX_ATTEMPTS) throw err;
      if (err.message?.startsWith("Mistral API error")) throw err; // already decided
      const waitMs = 500 * 2 ** (attempt - 1);
      console.warn(`[llm] network error, retrying in ${waitMs}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  if (!response?.ok) throw lastError ?? new Error("Mistral request failed.");

  const data = await response.json();

  // The API can return several alternative replies. We always want the first.
  const message = data.choices?.[0]?.message;

  if (!message) {
    throw new Error(
      `Unexpected API response shape: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  // Attach token usage so the agent loop can enforce a cost budget. It rides
  // on the message under an underscore-prefixed key to mark it as OUR metadata
  // rather than part of the provider's message format - the loop strips it
  // before the message goes back to the API.
  message._usage = data.usage ?? {};

  // We return the whole message object, not just message.content, because this
  // object also carries `tool_calls`. Returning the full object means the agent
  // loop never needs this signature to change.
  return message;
}

module.exports = { callLLM, DEFAULT_MODEL };
