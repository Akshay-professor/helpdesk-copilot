/**
 * speechFormat.js
 *
 * Turning an answer written for EYES into one written for EARS.
 *
 * ---------------------------------------------------------------------------
 * THE REQUIREMENT
 * ---------------------------------------------------------------------------
 *
 * > "Responses must be rewritten for speech - a formatted table or bulleted
 * >  list is unspeakable. Same agent core, different output formatter."
 *
 * Note the last five words. The agent does NOT get a second personality for
 * voice. It produces one answer, and this file translates it. That is the
 * difference between a formatter and a fork.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE IS UNSPEAKABLE
 * ---------------------------------------------------------------------------
 *
 * Here is a real reply from our own agent:
 *
 *     | Invoice ID | Order ID | Amount | Status |
 *     |------------|----------|--------|--------|
 *     | inv_5001   | ord_1001 | $240.00| paid   |
 *     | inv_5002   | ord_1002 | $89.99 | paid   |
 *
 * Read aloud by a screen reader that is exactly what you get:
 *
 *     "pipe Invoice ID pipe Order ID pipe Amount pipe Status pipe
 *      dash dash dash dash..."
 *
 * THE ANALOGY. A table is a MAP and speech is DIRECTIONS. A map is better when
 * you can see it - you take in the whole thing at once and choose your own
 * route. But nobody reads a map aloud. They say "second left after the
 * roundabout". Same information, restructured for a listener who cannot skim,
 * cannot go back, and can only hold a few things in their head at once.
 *
 * ---------------------------------------------------------------------------
 * WHY CODE FIRST, MODEL SECOND
 * ---------------------------------------------------------------------------
 *
 * Most of this job is deterministic. "$240.00" always becomes "240 dollars".
 * "ord_1001" always becomes "order 1 0 0 1". Paying an LLM to do a
 * substitution a regex can do is slow, dear, and less reliable.
 *
 * So: code handles everything mechanical. The model is asked only when the
 * structure itself needs rethinking - a table of five rows has to become a
 * sentence, and no amount of find-and-replace does that.
 *
 * Same split as every other decision in this project. Code checks facts, the
 * model judges what needs judgement.
 */

const { callLLM } = require("../llm/llmClient");

// ---------------------------------------------------------------------------
// The deterministic pass
// ---------------------------------------------------------------------------

/**
 * Speak an identifier digit by digit.
 *
 * "ord_1001" spoken as "ord one thousand and one" is useless - the customer
 * needs to write it down or compare it to an email. Digits, separately, is how
 * a human reads a reference number aloud.
 */
function speakId(prefix, digits) {
  const WORD = {
    ord: "order",
    inv: "invoice",
    cus: "customer",
    ref: "reference",
    txn: "transaction",
  };
  const spoken = String(digits).split("").join(" ");
  return `${WORD[prefix.toLowerCase()] ?? prefix} ${spoken}`;
}

/**
 * Money, the way a person says it.
 *
 *   $240.00  ->  "240 dollars"           (not "240 point zero zero dollars")
 *   $89.99   ->  "89 dollars 99 cents"
 *   $0.50    ->  "50 cents"
 */
function speakMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} dollars`;

  const whole = Math.floor(n);
  const cents = Math.round((n - whole) * 100);

  if (whole === 0) return `${cents} cents`;
  if (cents === 0) return `${whole} dollar${whole === 1 ? "" : "s"}`;
  return `${whole} dollar${whole === 1 ? "" : "s"} ${cents} cents`;
}

/**
 * Strip markdown and expand notation into words.
 *
 * Ordering matters here. Tables are handled before bullets, because a table
 * row starts with a pipe and would otherwise survive the bullet pass as
 * gibberish.
 */
function mechanicalPass(text) {
  let out = String(text ?? "");

  // --- structure that cannot be spoken at all -----------------------------

  // Code fences: say that code exists rather than reading its punctuation.
  out = out.replace(/```[\s\S]*?```/g, " (I have the details on screen.) ");
  out = out.replace(/`([^`]+)`/g, "$1");

  // Markdown tables -> nothing here; the LLM pass restructures them. We only
  // mark them so the caller knows a rewrite is REQUIRED, not optional.
  // (see needsRewrite below)

  // Headings, bold, italics, links.
  out = out.replace(/^#{1,6}\s*/gm, "");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Bullets and numbered lists -> spoken connectives.
  // A screen reader says "hyphen"; a person says "also".
  const lines = out.split("\n");
  let bulletIndex = 0;
  out = lines
    .map((line) => {
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        bulletIndex += 1;
        const lead = bulletIndex === 1 ? "" : "Also, ";
        return `${lead}${bullet[1]}`;
      }
      const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (numbered) {
        const ORDINAL = ["", "First, ", "Second, ", "Third, ", "Fourth, ", "Fifth, "];
        return `${ORDINAL[Number(numbered[1])] ?? ""}${numbered[2]}`;
      }
      bulletIndex = 0; // a non-bullet line ends the run
      return line;
    })
    .join("\n");

  // --- notation -> words --------------------------------------------------

  out = out.replace(/\$\s?([\d,]+(?:\.\d{1,2})?)/g, (_, amt) =>
    speakMoney(amt.replace(/,/g, ""))
  );

  // IDs, digit by digit.
  //
  // The leading (\w+\s+)? capture is not decoration. Our own confirmation text
  // reads "Refund $55.00 for order ord_1001", so a naive replacement produced:
  //
  //     "Refund 55 dollars for order ORDER 1 0 0 1"
  //
  // The word is already there. If the token immediately before the ID is the
  // word we were about to say, we consume it rather than repeat it. Stuttering
  // is far more obvious by ear than on a page - which is exactly the kind of
  // bug that only shows up when you listen to the output instead of reading it.
  // The optional leading word must consume its OWN trailing space, not the
  // separator before it - otherwise "See ord_1001" became "Seeorder 1 0 0 1".
  // Matching `(word\s+)?` rather than `(word)?\s*` keeps the space that was
  // never ours to eat.
  out = out.replace(
    /\b(?:(order|invoice|customer|reference|transaction)\s+)?(ord|inv|cus|ref|txn)_(\d+)\b/gi,
    (_, lead, prefix, digits) => speakId(prefix, digits)
  );

  // Dates: 2026-08-20 -> "20 August 2026". A listener cannot parse ISO.
  const MONTHS = ["January","February","March","April","May","June","July",
                  "August","September","October","November","December"];
  out = out.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) =>
    `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`
  );

  // Percentages and common abbreviations.
  out = out.replace(/(\d+)\s?%/g, "$1 percent");
  out = out.replace(/\be\.g\.\s*/gi, "for example ");
  out = out.replace(/\bi\.e\.\s*/gi, "that is ");
  out = out.replace(/\betc\.?/gi, "and so on");
  out = out.replace(/\bvs\.?\b/gi, "versus");
  out = out.replace(/&/g, " and ");

  // Email addresses read as punctuation soup otherwise.
  out = out.replace(/\b([\w.+-]+)@([\w-]+)\.([\w.]+)\b/g, (_, u, d, t) =>
    `${u.replace(/\./g, " dot ")} at ${d} dot ${t}`
  );

  // --- whitespace ---------------------------------------------------------
  out = out.replace(/\n{2,}/g, ". ");
  out = out.replace(/\n/g, ". ");
  out = out.replace(/\s{2,}/g, " ");
  out = out.replace(/\.\s*\./g, ".");
  out = out.replace(/\s+([.,!?])/g, "$1");

  return out.trim();
}

// ---------------------------------------------------------------------------
// Deciding whether the model is needed
// ---------------------------------------------------------------------------

/** Roughly how long this will take to say, at ~150 words per minute. */
function estimateSpeechSeconds(text) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 150) * 60);
}

/**
 * Does this answer need genuine restructuring, or just tidying?
 *
 * The expensive path is only worth taking when the SHAPE of the answer is
 * wrong for speech - a table, a long list, or an answer so long the listener
 * will lose the thread. Everything else the regexes above already handled.
 */
function needsRewrite(text) {
  const s = String(text ?? "");

  const hasTable = /^\s*\|.*\|/m.test(s);
  const bulletCount = (s.match(/^\s*[-*+]\s+/gm) ?? []).length;
  const tooLong = estimateSpeechSeconds(s) > 30;

  return {
    needed: hasTable || bulletCount >= 4 || tooLong,
    hasTable,
    bulletCount,
    estimatedSeconds: estimateSpeechSeconds(s),
    reason: hasTable
      ? "contains a table, which cannot be read aloud"
      : bulletCount >= 4
      ? `contains ${bulletCount} bullets - too many to follow by ear`
      : tooLong
      ? `would take about ${estimateSpeechSeconds(s)} seconds to say`
      : "already speakable",
  };
}

// ---------------------------------------------------------------------------
// The model pass
// ---------------------------------------------------------------------------

const REWRITE_PROMPT = `You rewrite customer support answers to be SPOKEN aloud
on a phone call. You are not summarising and you are not adding anything.

RULES:
- Never invent, change, or drop a fact. Every number, ID and date in the input
  must survive into the output. If you cannot keep them all, keep the ones that
  answer the question and say how many you left out.
- No markdown. No tables, bullets, headings, asterisks or pipes.
- Turn tables and lists into sentences. For more than three items, say the
  count first: "You have five invoices. The most recent is..."
- Short sentences. A listener cannot re-read a long one.
- Speak amounts as words: "240 dollars", not "$240.00".
- Speak IDs digit by digit: "order 1 0 0 1".
- Aim for under 25 seconds of speech, roughly 60 words.
- Plain, warm, and direct. This is a person on a call, not a document.

Return ONLY the spoken version. No preamble, no quotes around it.`;

/**
 * Rewrite an answer for speech.
 *
 * NEVER THROWS. If the model is unavailable we return the mechanical pass,
 * which is imperfect but perfectly speakable. A voice call must not fail
 * because a formatter was unavailable - the same fallback discipline as the
 * planner and the intent classifier.
 */
async function formatForSpeech(text, { model, force = false } = {}) {
  const original = String(text ?? "");
  if (!original.trim()) {
    return { text: "", rewritten: false, reason: "empty" };
  }

  const assessment = needsRewrite(original);
  const mechanical = mechanicalPass(original);

  if (!assessment.needed && !force) {
    return {
      text: mechanical,
      rewritten: false,
      reason: assessment.reason,
      estimatedSeconds: estimateSpeechSeconds(mechanical),
    };
  }

  try {
    const reply = await callLLM({
      model,
      messages: [
        { role: "system", content: REWRITE_PROMPT },
        { role: "user", content: original },
      ],
    });

    // Run the mechanical pass over the model's output too. It writes "$240"
    // out of habit no matter how clearly the prompt says otherwise, and the
    // regexes are free.
    const spoken = mechanicalPass(reply.content ?? "");

    if (!spoken.trim()) throw new Error("rewrite came back empty");

    return {
      text: spoken,
      rewritten: true,
      reason: assessment.reason,
      estimatedSeconds: estimateSpeechSeconds(spoken),
      tokens: reply._usage?.total_tokens ?? 0,
    };
  } catch (err) {
    console.warn(`[voice] speech rewrite failed (${err.message}) - using mechanical pass.`);
    return {
      text: mechanical,
      rewritten: false,
      degraded: true,
      reason: `rewrite unavailable: ${err.message}`,
      estimatedSeconds: estimateSpeechSeconds(mechanical),
    };
  }
}

module.exports = {
  formatForSpeech,
  mechanicalPass,
  needsRewrite,
  estimateSpeechSeconds,
  speakMoney,
  speakId,
};
