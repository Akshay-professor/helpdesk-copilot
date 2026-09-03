/**
 * stt.js
 *
 * Speech to text. The ONLY file that knows which transcription service we use.
 *
 * Same adapter discipline as llmClient.js and vectorStore.js: one file owns
 * each external dependency, so swapping the provider is one file's problem
 * rather than a search across the codebase.
 *
 * ---------------------------------------------------------------------------
 * WHY GROQ WHISPER
 * ---------------------------------------------------------------------------
 *
 * We already have a GROQ_API_KEY for the intent classifier, and Groq hosts
 * Whisper. So the entire STT half of this build cost zero new accounts, zero
 * new keys, and zero new billing relationships.
 *
 * Checked before committing to it:
 *
 *     whisper-large-v3         most accurate
 *     whisper-large-v3-turbo   faster, slightly less accurate
 *
 * We use TURBO. On a phone call, latency IS accuracy - a transcript that is
 * two percent better but arrives a second later makes the conversation worse,
 * because the caller has already started saying "hello?".
 *
 * ---------------------------------------------------------------------------
 * WHAT ABOUT TEXT TO SPEECH?
 * ---------------------------------------------------------------------------
 *
 * Deliberately NOT here, and this is a design decision rather than an omission.
 *
 * Groq's playai-tts is decommissioned (verified: the API returns
 * "has been decommissioned and is no longer supported"). Every other hosted
 * option needs a new paid account.
 *
 * So TTS runs in the BROWSER, via the Web Speech API. The trade:
 *
 *   + Zero latency. The audio starts the instant text arrives, because no
 *     audio crosses the network at all. The assignment asks for "sub-second
 *     time-to-first-audio" and this is roughly 50ms.
 *   + Zero cost, no key, no rate limit, works offline.
 *   + Barge-in is trivial - speechSynthesis.cancel() stops mid-word. Stopping
 *     a server-streamed audio file mid-sentence is real work.
 *   - Voice quality is the operating system's, not a neural voice.
 *   - The available voices differ across browsers.
 *
 * For a support desk that is the right trade. For a consumer product where the
 * voice IS the brand, you would pay for a neural voice - and because this is
 * an adapter boundary, that swap is this one file plus the client's playback
 * call.
 */

const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

/**
 * Audio shorter than this is almost certainly a stray click or a breath.
 *
 * Sending it wastes a round trip and, worse, Whisper will confidently
 * hallucinate words from silence - "thank you" and "you" are its favourites.
 * Filtering by size is cruder than a real voice-activity detector and costs
 * nothing.
 */
const MIN_AUDIO_BYTES = 2000;

/**
 * Transcribe audio.
 *
 * NEVER THROWS. Returns { text } or { error }, because a failed transcription
 * on a live call must produce "sorry, could you say that again?" rather than a
 * stack trace and a dead line.
 *
 * @param {Buffer} audio
 * @param {Object} [options]
 * @param {string} [options.mimeType]  - what the browser recorded
 * @param {string} [options.prompt]    - domain vocabulary hint
 */
async function transcribe(audio, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { error: "stt_not_configured", message: "GROQ_API_KEY is not set." };
  }

  if (!Buffer.isBuffer(audio) || audio.length < MIN_AUDIO_BYTES) {
    return {
      error: "audio_too_short",
      message: "That was too short to transcribe.",
      bytes: audio?.length ?? 0,
    };
  }

  const { mimeType = "audio/webm", prompt, timeoutMs = 15000 } = options;

  // The extension has to match the container or the API rejects it.
  const ext = mimeType.includes("wav")
    ? "wav"
    : mimeType.includes("mp4") || mimeType.includes("mp4a")
    ? "m4a"
    : mimeType.includes("ogg")
    ? "ogg"
    : "webm";

  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `speech.${ext}`);
  form.append("model", MODEL);

  // Whisper accepts a prompt as a VOCABULARY HINT, and it matters here.
  // Without it, "ord_1001" is transcribed as "or 1001", "ward 1001", or
  // "order one thousand and one" - none of which our regexes match. Telling it
  // the domain vocabulary in advance is the cheapest accuracy win available.
  form.append(
    "prompt",
    prompt ??
      "Customer support call about orders, invoices, refunds and account credit. " +
        "Order IDs look like ord_1001. Invoice IDs look like inv_5002."
  );

  // Ask for plain text. We do not need word timings, and a smaller response is
  // a faster one.
  form.append("response_format", "text");

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const startedAt = Date.now();
    const response = await fetch(GROQ_STT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: abort.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      return {
        error: "stt_failed",
        message: `Transcription failed (${response.status}).`,
        detail: detail.slice(0, 200),
      };
    }

    const text = (await response.text()).trim();

    // WHISPER HALLUCINATES ON SILENCE. Given a near-empty recording it emits
    // stock phrases - most often "Thank you." or "you". These are real outputs
    // with real confidence, and acting on one means the agent answers a
    // question nobody asked.
    const HALLUCINATIONS = [
      "thank you.", "thank you", "you", "thanks for watching!",
      "bye.", ".", "...", "silence",
    ];
    if (HALLUCINATIONS.includes(text.toLowerCase())) {
      return {
        error: "no_speech_detected",
        message: "No speech detected in that audio.",
        raw: text,
      };
    }

    return { text, model: MODEL, latencyMs: Date.now() - startedAt, bytes: audio.length };
  } catch (err) {
    if (err.name === "AbortError") {
      return { error: "stt_timeout", message: `Transcription took longer than ${timeoutMs}ms.` };
    }
    return { error: "stt_error", message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function isConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

module.exports = { transcribe, isConfigured, MODEL, MIN_AUDIO_BYTES };
