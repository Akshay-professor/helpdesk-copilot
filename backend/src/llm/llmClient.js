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

// ---------------------------------------------------------------------------
// THE FALLBACK PROVIDER
// ---------------------------------------------------------------------------
//
// Added after a real incident: Mistral's free-tier daily quota ran out
// mid-session and EVERY request started failing with 429. Retrying did not
// help - retry is for a service that is briefly busy, not one that has told
// you "you are done for today".
//
// Meanwhile Groq was sitting right there, configured, healthy, and unused.
// We had a working LLM and did not call it.
//
// The distinction that matters:
//
//   RETRY     same provider, a moment later    "you are busy"
//   FALLBACK  a different provider, now        "you are out of quota"
//
// Groq speaks the OpenAI chat-completions dialect, which Mistral also speaks,
// so the request body needs no translation - only a different URL, key, and
// model name. That is the whole reason a fallback is cheap here, and it is
// worth noticing WHY: we never coupled ourselves to one provider's SDK.
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
//
// Model choice: verified against the actual key with GET /v1/models rather
// than assumed. The first attempt hard-coded "llama-3.3-70b-versatile", which
// this account cannot access - a 404 that looked exactly like the fallback
// "not working". Ask the provider what it has; do not guess from memory.
//
// A CHAIN, not a single model. Groq's rate limits are PER MODEL, not per
// account - measured directly: gpt-oss-120b returned 429 while gpt-oss-20b
// and compound-mini both returned 200 on the same key, in the same second.
//
// So one exhausted model is not an exhausted provider, and treating it as one
// throws away capacity that is sitting right there. Ordered strongest first;
// we drop down only as each is exhausted.
const GROQ_FALLBACK_MODELS = (
  process.env.GROQ_FALLBACK_MODELS ||
  // Both verified to support TOOL CALLING, which the agent loop requires.
  //
  // groq/compound-mini was in this list and had to come out: it answers plain
  // chat fine but returns 400 "`tool calling` is not supported with this
  // model" for every agent request. A fallback that cannot do the job is not a
  // fallback - it is a slower way to fail.
  //
  // Test a candidate WITH a tools array before adding it, not with "hi".
  "openai/gpt-oss-120b,openai/gpt-oss-20b"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/** Is a second provider available to fall back to? */
function hasFallback() {
  return Boolean(process.env.GROQ_API_KEY);
}

// ---------------------------------------------------------------------------
// THE CIRCUIT BREAKER
// ---------------------------------------------------------------------------
//
// Falling back works, but the first version paid the full retry cost EVERY
// time: 500ms + 1000ms wasted on a provider we already knew was out of quota,
// on every single call. A voice turn makes ~3 LLM calls, so that was 4.5
// seconds of pure waiting - enough to make a call feel broken.
//
// A daily quota does not recover in 500ms. Once we have seen it, believe it.
//
//   THE IDEA: after a rate-limit, stop knocking on that door for a while.
//   Send everything straight to the fallback, and only try the primary again
//   once the cool-down has passed.
//
// This is the standard "circuit breaker" pattern, and the name is apt: a
// breaker trips to stop you repeatedly energising a circuit that is faulty.
//
// Deliberately NOT tripped by 5xx or network errors - those really can clear
// in a second, and retry is the right answer for them. Only a 429 means
// "stop asking".
const BREAKER_COOLDOWN_MS = 60_000;
let primaryDownUntil = 0;

function primaryIsTripped() {
  return Date.now() < primaryDownUntil;
}

function tripPrimary() {
  if (!primaryIsTripped()) {
    console.warn(
      `[llm] Mistral rate-limited — skipping it for ${BREAKER_COOLDOWN_MS / 1000}s`
    );
  }
  primaryDownUntil = Date.now() + BREAKER_COOLDOWN_MS;
}

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

  // Breaker open: do not even try the primary. Straight to the fallback.
  if (primaryIsTripped() && hasFallback()) {
    lastError = new Error("Mistral skipped — circuit breaker open (rate limited).");
  } else
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

      // BREAK, not throw. A `throw` here jumps past the fallback block below,
      // which is exactly the bug that made the first version of this fallback
      // do nothing at all: Mistral 429'd, all three retries were spent, and
      // the throw skipped the healthy provider sitting one block away.
      //
      // `lastError` is still set, so the code after the loop can decide
      // between falling back and giving up. Exiting a loop and abandoning the
      // function are different intentions - use the one you actually mean.
      // A 429 means the quota is gone, not that the server is briefly busy.
      // Trip the breaker so the next caller does not repeat this wait.
      if (response.status === 429) {
        tripPrimary();
        break;
      }

      if (!RETRYABLE.includes(response.status) || attempt === MAX_ATTEMPTS) {
        break;
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
      // Same reasoning as above: break so the fallback gets its turn.
      if (attempt === MAX_ATTEMPTS) break;
      if (err.message?.startsWith("Mistral API error")) break; // already decided
      const waitMs = 500 * 2 ** (attempt - 1);
      console.warn(`[llm] network error, retrying in ${waitMs}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  // ---- FALL BACK TO THE OTHER PROVIDER ----------------------------------
  //
  // Every retry is spent and we still have no answer. Before giving up, try
  // the second provider - a 429 from Mistral says nothing at all about
  // whether Groq is healthy.
  //
  // Note this is attempted for ANY exhausted failure, not only 429. If the
  // primary is unreachable for any reason and a working alternative exists,
  // using it is strictly better than returning an error to a customer.
  if (!response?.ok && hasFallback()) {
    console.warn(
      `[llm] Mistral unavailable (${lastError?.message?.slice(0, 60)}…) — ` +
        `falling back to Groq (${GROQ_FALLBACK_MODELS.length} models)`
    );

    let fb;
    try {
      // Walk the chain. Each 429 means "this model is spent", not "give up".
      for (const model of GROQ_FALLBACK_MODELS) {
        fb = await fetch(GROQ_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          // Same body, different model. The dialect is identical.
          body: JSON.stringify({ ...body, model }),
        });

        if (fb.ok) {
          const data = await fb.json();
          const message = data.choices?.[0]?.message;
          if (message) {
            message._usage = data.usage ?? {};
            // Mark it, so a trace shows WHICH provider answered. A silent
            // fallback is a system that lies about its own behaviour.
            message._provider = `groq:${model}`;
            return message;
          }
        }

        // Which failures are worth trying the next model for?
        //
        //   429  yes - this model is spent, another may not be
        //   400  yes IF it is a capability gap ("tool calling is not
        //        supported"), because a different model may support it.
        //        Otherwise no: a malformed request stays malformed.
        //   else no - stop and report.
        // NOT `body` - that name is already the request body in this scope,
        // and shadowing it threw "Cannot access 'body' before initialization"
        // on the very first call.
        const errBody = await fb.clone().text().catch(() => "");
        const capabilityGap =
          fb.status === 400 && /not supported|does not support/i.test(errBody);

        if (fb.status !== 429 && !capabilityGap) break;

        console.warn(
          `[llm] ${model} ${capabilityGap ? "lacks a needed capability" : "rate limited"}` +
            `, trying the next model`
        );
      }
      // Report the FALLBACK's failure, not the primary's stale one.
      //
      // The first version let `lastError` stand, so when both providers were
      // rate limited the thrown error read "circuit breaker open" - which
      // describes our own bookkeeping, not what actually went wrong. Whoever
      // reads that error needs to know BOTH doors were shut.
      const fbText = await fb.text().catch(() => "");
      lastError = new Error(
        `All providers failed. Mistral: ${lastError?.message?.slice(0, 80) ?? "n/a"} | ` +
          `Groq ${fb.status}: ${fbText.slice(0, 120)}`
      );
      console.warn(`[llm] fallback also failed (${fb.status})`);
    } catch (err) {
      lastError = new Error(
        `All providers failed. Fallback threw: ${err.message}`
      );
      console.warn(`[llm] fallback threw: ${err.message}`);
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
  message._provider = "mistral";

  // We return the whole message object, not just message.content, because this
  // object also carries `tool_calls`. Returning the full object means the agent
  // loop never needs this signature to change.
  return message;
}

module.exports = { callLLM, DEFAULT_MODEL };
