/**
 * researchAgent.js
 *
 * The Build 3 research agent, worth 20 marks.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS DIFFERENT FROM EVERY AGENT SO FAR
 * ---------------------------------------------------------------------------
 *
 * Every agent up to now answers a question that HAS an answer sitting
 * somewhere. "Where is my order" - look it up, say it. One question, one
 * lookup, one reply.
 *
 * A research question has no such row:
 *
 *     "Are customers on the Pro plan churning more than last quarter, and why?"
 *
 * Nothing in the database says "churn". The answer has to be BUILT from
 * several partial views, none of which is the answer by itself.
 *
 * THE ANALOGY. A support agent is a librarian: you ask for a book, they fetch
 * it. A researcher is a journalist: given "is the product getting worse", they
 * break it into questions ("more complaints? slower delivery? more refunds?"),
 * chase each one down separately, write it up with sources, and say plainly
 * what they could not confirm. That last part is what separates journalism
 * from gossip.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR STAGES
 * ---------------------------------------------------------------------------
 *
 *   1. DECOMPOSE   turn one open question into 3-5 answerable sub-questions
 *   2. INVESTIGATE run them IN PARALLEL, each against real sources
 *   3. SYNTHESIZE  merge into a report where every claim cites its source
 *   4. ASSESS      state confidence, and name what could NOT be determined
 *
 * ---------------------------------------------------------------------------
 * THE REQUIREMENT THAT DRIVES THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 *
 * > "States its own confidence and explicitly names what it couldn't determine
 * >  - 'I found X but couldn't verify Y' is a correct and valuable answer; a
 * >  confident fabrication is the failure mode this guards against."
 *
 * An LLM asked "why are customers churning" will ALWAYS produce a confident
 * answer. That is what they do. If the data does not support a conclusion, it
 * will invent one that sounds right.
 *
 * So confidence here is NOT the model's opinion of itself. Asking a model "how
 * sure are you?" measures its writing style, not its evidence. Instead we
 * compute it from facts the model does not control:
 *
 *     - how many sub-questions actually found data
 *     - how many rows came back
 *     - how many sources failed outright
 *
 * The model writes the prose. CODE decides how much to trust it. Same division
 * of labour as reflection.js in Build 2, and for the same reason.
 */

const crypto = require("crypto");
const { callLLM } = require("../llm/llmClient");
const { runSource, describeSources } = require("./sources");
const { ResearchReport } = require("../db/models");

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Sub-questions per investigation.
 *
 * The assignment says "3 of 5 sub-questions" in its own progress example, so
 * 5 is the intended ceiling. Each sub-question costs at least one source call
 * and contributes to one synthesis prompt; ten would produce a report nobody
 * reads, built from a context window nobody can afford.
 */
const MAX_SUBQUESTIONS = 5;

/** Sources one sub-question may consult. Keeps a single thread bounded. */
const MAX_SOURCES_PER_SUBQ = 3;

/**
 * Confidence thresholds, as data rather than scattered if-statements.
 *
 * Written here so the rule can be READ and argued with, instead of being
 * reverse-engineered out of the code.
 */
/**
 * ---------------------------------------------------------------------------
 * THE CONFIDENCE ALGORITHM
 * ---------------------------------------------------------------------------
 *
 * Four signals, each scored 0..1, combined by WEIGHT into one number, then cut
 * into three bands. Written out as data so the rule can be read and argued
 * with rather than reverse-engineered from nested if-statements.
 *
 *   COVERAGE   0.45   what fraction of sub-questions found RELEVANT data?
 *   EVIDENCE   0.25   how many relevant rows, saturating at 20?
 *   BREADTH    0.20   how many DIFFERENT sources corroborate?
 *   HEALTH     0.10   did every source we called actually work?
 *
 * WHY THESE WEIGHTS. Coverage dominates because a report that answered one of
 * four sub-questions has not answered the question, however many rows that one
 * produced. Breadth matters because two sources agreeing is a much stronger
 * claim than one source repeated - the same reason a journalist wants a second
 * confirmation. Health is small but non-zero: a broken source means the report
 * is built on a partial view even if what survived looked fine.
 *
 * WHY IT SATURATES. `Math.min(rows/20, 1)` - going from 3 rows to 20 is a real
 * increase in evidence; going from 200 to 2,000 is not. A linear score would
 * let one huge aggregate drown out three empty sub-questions.
 *
 * WHY A SCORE AND NOT NESTED IFS. The first version was
 * `if (ratio >= 0.75 && rows >= 3)`, and it scored the churn report MEDIUM
 * because 2 of 4 sub-questions scraped past a threshold - while the report
 * itself said the data did not exist. Hard thresholds hide near-misses; a
 * weighted score degrades smoothly, which is what you want from a measure of
 * doubt.
 */
const WEIGHTS = { coverage: 0.45, evidence: 0.25, breadth: 0.2, health: 0.1 };

/** Score -> label. A band, not a cliff. */
const BANDS = [
  { min: 0.7, label: "high" },
  { min: 0.4, label: "medium" },
  { min: 0, label: "low" },
];

/** Evidence saturates here - see the comment above. */
const EVIDENCE_SATURATION = 20;

// ---------------------------------------------------------------------------
// STAGE 1 - DECOMPOSE
// ---------------------------------------------------------------------------

const DECOMPOSE_PROMPT = `You break an open-ended business question into
answerable sub-questions.

You will be given the question and the DATA SOURCES actually available. Only
propose sub-questions those sources could genuinely answer - a sub-question
nothing can answer wastes an investigation slot and produces a gap, not a
finding.

Return ONLY valid JSON, no prose:

{
  "subQuestions": [
    {
      "question": "the sub-question in plain English",
      "sources": [
        { "name": "sourceName", "args": { ... } }
      ]
    }
  ]
}

Rules:
- Between 2 and ${MAX_SUBQUESTIONS} sub-questions.
- At most ${MAX_SOURCES_PER_SUBQ} sources each.
- Use ONLY source names from the list given. Do not invent sources.
- Prefer sub-questions that different sources answer, so the findings
  corroborate rather than repeat each other.`;

/**
 * Break the question down.
 *
 * Returns null on any failure, and the caller falls back to a single
 * sub-question equal to the original. Decomposition is an ENHANCEMENT - a
 * research agent that dies because the planner had a bad day is worse than one
 * that investigates the question as asked.
 */
async function decompose(question, { model } = {}) {
  const sources = describeSources();

  const messages = [
    { role: "system", content: DECOMPOSE_PROMPT },
    {
      role: "user",
      content:
        `QUESTION: ${question}\n\n` +
        `AVAILABLE SOURCES:\n${JSON.stringify(sources, null, 2)}`,
    },
  ];

  try {
    const reply = await callLLM({ messages, model });
    const text = (reply.content ?? "").trim();

    // Models wrap JSON in ```json fences no matter how firmly you ask them not
    // to. Strip rather than fail - see planner.js, same fix, same reason.
    const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const parsed = JSON.parse(json);

    if (!Array.isArray(parsed.subQuestions) || parsed.subQuestions.length === 0) {
      return null;
    }

    return {
      subQuestions: parsed.subQuestions.slice(0, MAX_SUBQUESTIONS).map((sq) => ({
        question: String(sq.question ?? "").trim(),
        sources: Array.isArray(sq.sources)
          ? sq.sources.slice(0, MAX_SOURCES_PER_SUBQ)
          : [],
      })),
      tokens: reply._usage?.total_tokens ?? 0,
    };
  } catch (err) {
    console.warn(`[research] decomposition failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// STAGE 2 - INVESTIGATE, IN PARALLEL
// ---------------------------------------------------------------------------

/**
 * Investigate one sub-question by running its sources.
 *
 * Note `Promise.all` INSIDE a sub-question and `Promise.all` across them in
 * the caller. Both layers are parallel, because none of these reads depend on
 * each other.
 *
 * THE ANALOGY. Five journalists on one story do not queue up to use one phone.
 * They call their own contacts simultaneously and meet back at the desk. Five
 * sequential database reads take five times as long for exactly the same
 * answer.
 */
async function investigate(subQuestion) {
  const startedAt = Date.now();

  const results = await Promise.all(
    (subQuestion.sources ?? []).map(async (s) => {
      const data = await runSource(s.name, s.args ?? {});
      return { requested: s, ...data };
    })
  );

  const withData = results.filter((r) => !r.error && r.n > 0);
  const failed = results.filter((r) => r.error);
  const empty = results.filter((r) => !r.error && r.n === 0);

  // A source can return rows that have nothing to do with the question - see
  // the long comment on assessConfidence(). "Rows came back" and "we found an
  // answer" are different claims, and only the second one counts.
  const relevant = withData.filter((r) => isRelevant(subQuestion.question, r.rows));

  return {
    question: subQuestion.question,
    results,
    // These counts are what STAGE 4 scores confidence from. The model never
    // sees them as an opinion to agree with - they are measurements.
    rowsFound: relevant.reduce((n, r) => n + r.n, 0),
    rowsReturned: withData.reduce((n, r) => n + r.n, 0),
    sourcesWithData: withData.length,
    sourcesRelevant: relevant.length,
    sourcesFailed: failed.length,
    sourcesEmpty: empty.length,
    // THE FIX: answered means "found something that bears on the question",
    // not "the query did not error".
    answered: relevant.length > 0,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// STAGE 3 - SYNTHESIZE
// ---------------------------------------------------------------------------

const SYNTHESIS_PROMPT = `You write a short research report from findings that
have already been gathered. You do NOT have access to any other information.

ABSOLUTE RULES:

1. EVERY factual claim must cite the source it came from, inline, like this:
       Delivered orders total $2,835 [mongodb:orders].
   A number without a citation is not allowed. If you cannot cite it, do not
   write it.

2. NEVER state anything the findings do not contain. Do not estimate, do not
   extrapolate, do not fill a gap with what is usually true. If the data does
   not say it, it is not in the report.

3. If a sub-question found nothing, SAY SO plainly. "No refund records exist,
   so refund rates could not be assessed" is a correct and useful sentence.

4. Small samples must be flagged. Three orders is not a trend. If a claim rests
   on very few rows, say the sample is small in the same sentence as the claim.

Write in plain English, 150-300 words. Structure:
- What was asked
- What the evidence shows, with citations
- What could not be determined and why

Do not invent a conclusion to make the report feel finished. An honest
"the data does not settle this" IS the finding.`;

async function synthesize(question, investigations, { model } = {}) {
  const findings = investigations.map((inv) => ({
    subQuestion: inv.question,
    answered: inv.answered,
    findings: inv.results.map((r) => ({
      source: r.source,
      query: r.query,
      rowCount: r.n,
      error: r.error ?? null,
      // Cap the rows sent to the model. A large aggregate would crowd out the
      // instructions above, and the instructions are the whole point.
      data: r.error ? null : (r.rows ?? []).slice(0, 8),
    })),
  }));

  const messages = [
    { role: "system", content: SYNTHESIS_PROMPT },
    {
      role: "user",
      content:
        `ORIGINAL QUESTION: ${question}\n\n` +
        `FINDINGS:\n${JSON.stringify(findings, null, 2)}`,
    },
  ];

  const reply = await callLLM({ messages, model });
  return {
    report: (reply.content ?? "").trim(),
    tokens: reply._usage?.total_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// STAGE 4 - ASSESS CONFIDENCE (in code, not by asking the model)
// ---------------------------------------------------------------------------

/**
 * Score how much this report should be trusted.
 *
 * THE KEY DESIGN DECISION: we do not ask the model how confident it is.
 *
 * A model asked "how sure are you?" answers from tone, not evidence - it will
 * happily rate a report built on zero rows as "high confidence" if the prose
 * reads smoothly. What it is really reporting is how fluent the writing felt.
 *
 * So confidence is computed from things the model cannot influence: how many
 * sub-questions found data, how many rows there were, how many sources broke.
 *
 * Same split as Build 2's reflection: the MODEL judges wording, CODE judges
 * facts. Every time this project has needed a guarantee rather than a hope,
 * the answer has been to move the check into JavaScript.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FUNCTION SHIPPED WITH, AND WHY IT IS INSTRUCTIVE
 * ---------------------------------------------------------------------------
 *
 * First version scored the churn question as confidence HIGH with ZERO gaps -
 * on a report whose own conclusion was "no Pro plan customers were present in
 * the results, so this comparison is not possible."
 *
 * The code said the investigation went well. The report said it went nowhere.
 *
 * The cause was one line:
 *
 *     answered: withData.length > 0        // "a source returned rows"
 *
 * The customerStats source DID return rows - two of them, for the STANDARD and
 * GOLD tiers. There is no Pro tier in our data at all. So the query succeeded,
 * returned data, and answered nothing.
 *
 * > GETTING DATA BACK IS NOT THE SAME AS GETTING YOUR ANSWER.
 *
 * This is the same shape as every measurement bug in this project: the
 * instrument reported on what was easy to count (rows) rather than on what was
 * being asked (relevance). And it is worse here than elsewhere, because a
 * research agent's ENTIRE job is to know the difference between evidence and
 * the absence of evidence.
 *
 * The fix is `relevance` below - a cheap, deterministic check that the rows
 * actually mention what the sub-question asked about.
 */

/**
 * Do these rows plausibly bear on this sub-question?
 *
 * Deliberately crude and deliberately NOT an LLM call. It extracts the
 * distinctive words from the sub-question and checks whether any appear in the
 * returned data.
 *
 * WHY CRUDE IS RIGHT HERE. This runs once per source, is free, and never
 * fails. A model call would be more accurate and would also mean the
 * confidence score - the one number in this system specifically designed NOT to
 * depend on a model's opinion - now depends on a model's opinion.
 *
 * A false "relevant" costs us an over-confident report. A false "irrelevant"
 * costs us a gap listed that did not need listing. The second error is much
 * cheaper than the first, which is why the threshold is one matching term.
 */
const STOPWORDS = new Set([
  "what", "which", "when", "where", "who", "why", "how", "the", "and", "are",
  "for", "with", "this", "that", "from", "have", "has", "was", "were", "there",
  "their", "our", "all", "any", "more", "than", "last", "most", "common",
  "reasons", "customers", "customer", "data", "records", "total", "over",
  "into", "about", "does", "did", "been", "being", "other", "such",
]);

function isRelevant(subQuestion, rows) {
  if (!rows || rows.length === 0) return false;

  const terms = String(subQuestion)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  // Nothing distinctive to look for - do not punish the sub-question for
  // being phrased in common words.
  if (terms.length === 0) return true;

  const haystack = JSON.stringify(rows).toLowerCase();
  return terms.some((t) => haystack.includes(t));
}

function assessConfidence(investigations) {
  const total = investigations.length || 1;
  const answered = investigations.filter((i) => i.answered).length;
  const answeredRatio = answered / total;
  const totalRows = investigations.reduce((n, i) => n + i.rowsFound, 0);
  const failedSources = investigations.reduce((n, i) => n + i.sourcesFailed, 0);

  // ---- THE FOUR SIGNALS, EACH NORMALISED TO 0..1 ------------------------
  //
  // Every one of these is a MEASUREMENT. None of them is an opinion, and none
  // of them can be influenced by how well the report reads.

  // 1. COVERAGE - did we answer what we set out to answer?
  const coverage = answeredRatio;

  // 2. EVIDENCE - how much relevant data, saturating so one huge aggregate
  //    cannot drown out three empty sub-questions.
  const evidence = Math.min(totalRows / EVIDENCE_SATURATION, 1);

  // 3. BREADTH - how many DIFFERENT sources corroborate?
  //
  //    One source saying something is a claim. Two independent sources saying
  //    it is a finding. Counted DISTINCTLY, so calling agentRunStats four
  //    times is still breadth of one.
  const distinctSources = new Set(
    investigations.flatMap((i) =>
      i.results.filter((r) => !r.error && r.n > 0).map((r) => r.source)
    )
  ).size;
  const breadth = Math.min(distinctSources / 3, 1);

  // 4. HEALTH - did everything we called actually work?
  const attempted = investigations.reduce((n, i) => n + i.results.length, 0) || 1;
  const health = 1 - failedSources / attempted;

  const score =
    WEIGHTS.coverage * coverage +
    WEIGHTS.evidence * evidence +
    WEIGHTS.breadth * breadth +
    WEIGHTS.health * health;

  const level = BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1];

  // The GAPS list. This is what the assignment means by "explicitly names what
  // it couldn't determine" - built from measurements, so it cannot be
  // optimistically forgotten by a model that would rather sound complete.
  const gaps = [];

  for (const inv of investigations) {
    if (!inv.answered) {
      // Three genuinely different reasons a sub-question went unanswered, and
      // the third is the one the first version of this code could not see.
      let reason;
      if (inv.sourcesFailed > 0) {
        reason = "every source consulted for this returned an error";
      } else if (inv.rowsReturned > 0) {
        // Data came back. It was about something else. This is the churn case:
        // customerStats returned the standard and gold tiers for a question
        // about the Pro tier.
        reason =
          `the sources returned ${inv.rowsReturned} record` +
          `${inv.rowsReturned === 1 ? "" : "s"}, but none of them relate to ` +
          `what was asked`;
      } else {
        reason = "the sources returned no matching records";
      }
      gaps.push({ subQuestion: inv.question, reason });
    }
    for (const r of inv.results.filter((x) => x.error)) {
      gaps.push({ subQuestion: inv.question, reason: r.error, source: r.source });
    }
  }

  if (totalRows > 0 && totalRows < 5) {
    gaps.push({
      subQuestion: "(overall)",
      reason:
        `Only ${totalRows} record${totalRows === 1 ? "" : "s"} support this ` +
        `report. That is too small a sample to establish a trend.`,
    });
  }

  return {
    level: level.label,
    score: Number(score.toFixed(3)),

    // THE BREAKDOWN. A score you cannot take apart is a rumour - the lesson
    // from the benchmark in Phase 18b, applied here before it could bite.
    // Anyone can now see WHICH signal dragged a report down.
    signals: {
      coverage: Number(coverage.toFixed(3)),
      evidence: Number(evidence.toFixed(3)),
      breadth: Number(breadth.toFixed(3)),
      health: Number(health.toFixed(3)),
    },
    weights: WEIGHTS,

    answeredSubQuestions: answered,
    totalSubQuestions: total,
    totalRows,
    distinctSources,
    failedSources,
    gaps,
    reason:
      `${answered} of ${total} sub-questions found relevant data across ` +
      `${totalRows} record${totalRows === 1 ? "" : "s"} from ${distinctSources} ` +
      `source${distinctSources === 1 ? "" : "s"}` +
      (failedSources > 0 ? `, with ${failedSources} source failure(s)` : "") +
      ` (score ${score.toFixed(2)}).`,
  };
}

// ---------------------------------------------------------------------------
// THE PIPELINE
// ---------------------------------------------------------------------------

/**
 * Run a full investigation.
 *
 * @param {string}   question
 * @param {Object}   [options]
 * @param {Function} [options.onEvent] - progress events. The assignment asks
 *        for "Investigating 3 of 5 sub-questions..." specifically, because a
 *        long job with no output looks identical to a hung one.
 * @param {string}   [options.reportId] - resume/refer to a known id.
 */
async function runResearch(question, options = {}) {
  const { model, onEvent, callerId } = options;
  const reportId = options.reportId ?? crypto.randomUUID();
  const startedAt = Date.now();
  let tokensUsed = 0;

  const emit = (type, payload = {}) => {
    if (onEvent) onEvent({ type, reportId, ...payload });
  };

  emit("research_started", { question });

  // ---- STAGE 1 ----------------------------------------------------------
  emit("research_stage", { stage: "decompose", message: "Breaking the question down…" });

  const decomposition = await decompose(question, { model });
  tokensUsed += decomposition?.tokens ?? 0;

  // The fallback matters: investigate the question as asked rather than give
  // up. A worse plan still beats no answer.
  const subQuestions = decomposition?.subQuestions ?? [
    {
      question,
      sources: [
        { name: "orderStats", args: { groupBy: "status" } },
        { name: "customerStats", args: {} },
      ],
    },
  ];

  emit("research_plan", {
    subQuestions: subQuestions.map((s) => s.question),
    decomposed: Boolean(decomposition),
  });

  // Persist BEFORE the slow part. If the process dies during investigation,
  // the question and plan survive - the same reasoning that put the paused
  // approval in MongoDB in Build 2.
  await saveReport({
    reportId,
    question,
    callerId,
    status: "investigating",
    subQuestions: subQuestions.map((s) => s.question),
    startedAt,
  });

  // ---- STAGE 2 ----------------------------------------------------------
  //
  // All sub-questions at once. The progress events still report "N of M" as
  // each one lands, because a user watching wants to see movement even though
  // the work is not sequential.
  let done = 0;
  const investigations = await Promise.all(
    subQuestions.map(async (sq) => {
      const inv = await investigate(sq);
      done += 1;
      emit("research_progress", {
        completed: done,
        total: subQuestions.length,
        message: `Investigated ${done} of ${subQuestions.length} sub-questions…`,
        subQuestion: sq.question,
        answered: inv.answered,
        rows: inv.rowsFound,
      });
      return inv;
    })
  );

  // ---- STAGE 4 (before 3 on purpose) ------------------------------------
  //
  // Confidence is computed from the RAW investigations, before any prose
  // exists. If it were computed afterwards, a well-written report could talk
  // the score up - which is exactly the failure this guards against.
  const confidence = assessConfidence(investigations);
  emit("research_confidence", confidence);

  // ---- STAGE 3 ----------------------------------------------------------
  emit("research_stage", { stage: "synthesize", message: "Writing the report…" });

  let report = "";
  let synthesisFailed = null;
  try {
    const synth = await synthesize(question, investigations, { model });
    report = synth.report;
    tokensUsed += synth.tokens;
  } catch (err) {
    // The findings are still real even if the writing step died. Hand back the
    // evidence rather than nothing.
    synthesisFailed = err.message;
    report =
      "The report could not be written because the language model was " +
      "unavailable. The raw findings are included below and are unaffected.";
  }

  const result = {
    reportId,
    question,
    status: "complete",
    report,
    confidence: confidence.level,
    confidenceReason: confidence.reason,
    // The raw score and its four components ride along with the label. A band
    // ("medium") tells you the verdict; the breakdown tells you which signal
    // produced it, which is the difference between a number you can act on and
    // one you can only accept.
    confidenceScore: confidence.score,
    confidenceSignals: confidence.signals,
    gaps: confidence.gaps,
    subQuestions: investigations.map((inv) => ({
      question: inv.question,
      answered: inv.answered,
      rowsFound: inv.rowsFound,
      durationMs: inv.durationMs,
      citations: inv.results.map((r) => ({
        source: r.source,
        query: r.query,
        rows: r.n,
        error: r.error ?? null,
      })),
    })),
    // Every distinct source consulted, deduplicated - the report's bibliography.
    citations: [
      ...new Set(
        investigations.flatMap((i) => i.results.filter((r) => !r.error).map((r) => r.source))
      ),
    ],
    tokensUsed,
    durationMs: Date.now() - startedAt,
    synthesisFailed,
    callerId,
    startedAt,
  };

  await saveReport(result);
  emit("research_complete", {
    confidence: result.confidence,
    gaps: result.gaps.length,
    citations: result.citations.length,
    tokensUsed,
    durationMs: result.durationMs,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Persistence - "must survive being closed and reopened"
// ---------------------------------------------------------------------------

/**
 * Save (or update) a report.
 *
 * Never throws. A research report that cannot be filed is still a research
 * report - losing the answer because the archive is down would be a strictly
 * worse outcome than not archiving it.
 */
async function saveReport(doc) {
  try {
    await ResearchReport.findOneAndUpdate(
      { reportId: doc.reportId },
      { $set: { ...doc, updatedAt: new Date() } },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error(`[research] could not save report ${doc.reportId}:`, err.message);
  }
}

async function getReport(reportId) {
  try {
    return await ResearchReport.findOne({ reportId }).lean();
  } catch {
    return null;
  }
}

async function listReports(limit = 20) {
  try {
    return await ResearchReport.find({})
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
  } catch {
    return [];
  }
}

module.exports = {
  runResearch,
  getReport,
  listReports,
  // Exported for the tests, which check each stage in isolation.
  decompose,
  investigate,
  assessConfidence,
  MAX_SUBQUESTIONS,
};
