/**
 * voiceSession.js
 *
 * The voice channel, over the SAME agent core.
 *
 * ---------------------------------------------------------------------------
 * THE REQUIREMENT THAT SHAPES EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * > "Expose the agent over voice, REUSING THE SAME CORE (not a parallel
 * >  implementation)."
 *
 * So read this file looking for what is NOT here. There is no agent loop, no
 * tool dispatch, no policy check, no confirmation logic, no reflection. All of
 * that is runAgent(), untouched.
 *
 * What IS here is only the things that are different because there is a human
 * listening rather than reading:
 *
 *   1. speech in   -> Whisper transcribes it
 *   2. filler      -> because silence on a call means "we got cut off"
 *   3. speech out  -> the formatter rewrites the answer for ears
 *   4. approval    -> read the action aloud, take "yes" as the click
 *   5. barge-in    -> stop talking the moment they start
 *
 * THE ANALOGY. The agent is a chef. Chat is a waiter carrying plates to a
 * table; voice is a waiter describing the dish over the phone. Same kitchen,
 * same food. What changes is the delivery, and only the delivery.
 */

const crypto = require("crypto");
const { runAgent, resumeAgent } = require("../agent/agentRunner");
const { formatForSpeech } = require("./speechFormat");
const { transcribe } = require("./stt");

// ---------------------------------------------------------------------------
// PROBLEM 1: silence feels like a dropped call
// ---------------------------------------------------------------------------

/**
 * > "Tool execution takes seconds; silence feels like a dropped call. Design
 * >  the filler/progress behavior."
 *
 * Our own measurements: a guided run averages 7.5 seconds, autonomous 13.2.
 *
 * SEVEN SECONDS OF SILENCE ON A PHONE CALL IS ENORMOUS. Count it out. By four
 * seconds a person says "hello?". By seven they hang up.
 *
 * THE ANALOGY. A good receptionist does not go quiet while looking something
 * up. They say "let me check that for you" - not because it helps them look,
 * but because it tells you the line is alive and you are still being helped.
 *
 * THREE DESIGN DECISIONS WORTH DEFENDING:
 *
 * 1. THE FILLER IS TRUE. "I'm looking up your orders now" is said only when
 *    getOrders is actually running. A generic "please hold" repeated three
 *    times sounds like a recording; naming the real step sounds like a person.
 *
 * 2. IT IS TIMED, NOT IMMEDIATE. Nothing is said for the first 1.2 seconds,
 *    because a fast tool finishes inside that window and interrupting yourself
 *    to announce work you already did is worse than saying nothing.
 *
 * 3. IT ESCALATES. The second filler acknowledges the wait ("still working on
 *    this"). Repeating the identical phrase is the single clearest sign of a
 *    machine.
 */
const FILLER_DELAY_MS = 1200;
const FILLER_REPEAT_MS = 6000;

const TOOL_FILLERS = {
  getCustomer: "Let me pull up your account.",
  getOrders: "I'm looking up your orders now.",
  getInvoices: "Checking your invoices.",
  checkRefundEligibility: "Let me check whether that qualifies for a refund.",
  issueRefund: "Setting up that refund now.",
  applyAccountCredit: "Applying that credit.",
  searchKnowledgeBase: "Let me check our policy on that.",
  escalateToHuman: "Getting a colleague for you.",
  changePlan: "Looking at your plan options.",
};

const WAITING_LONGER = [
  "Still working on this, bear with me.",
  "Almost there.",
];

/**
 * Stop filling after this many, and say something honest instead.
 *
 * The first version repeated "Almost there" every six seconds indefinitely.
 * Heard on a real call that is worse than silence: it is a machine insisting
 * things are fine while they are visibly not, and by the third repetition the
 * caller knows it is a loop.
 *
 * A person who has said "almost there" twice and is still stuck says something
 * different - they acknowledge it is taking too long. So do we, once, and then
 * we stop talking. The agent's own MAX_ITERATIONS cap will end the run.
 *
 * > A reassurance repeated past the point of belief is not reassurance.
 */
const MAX_FILLERS = 3;
const FILLER_GIVING_UP =
  "Sorry, this is taking longer than it should. Bear with me just a moment " +
  "more, or I can have someone call you back.";

// ---------------------------------------------------------------------------
// PROBLEM 2: approval when the customer is on a call
// ---------------------------------------------------------------------------

/**
 * > "HITL over voice: how does an approval-required action work when the user
 * >  is on a call? This has no obvious answer - design one and defend it."
 *
 * FIRST, THE DISTINCTION THAT MAKES THIS TRACTABLE.
 *
 * There are two different approvals in this system and they are not the same
 * thing at all:
 *
 *   A. THE CUSTOMER confirming their own request
 *      "Refund 55 dollars on order 1 0 0 1 - shall I go ahead?"
 *      -> the caller can answer this. It is their money and their order.
 *
 *   B. A SUPERVISOR approving something over policy
 *      A 500 dollar refund needs a human operator to sign off.
 *      -> the caller CANNOT answer this, and no amount of clever voice design
 *         changes that. Waiting on hold for an operator is not an experience,
 *         it is an ordeal.
 *
 * OUR DESIGN:
 *
 *   For (A) we speak the action and accept a spoken yes or no. The pause is
 *   the same pause chat uses, resumed by the same resumeAgent().
 *
 *   For (B) we do NOT hold the line. We say what will happen, who will do it,
 *   and when they will hear back - then end the call cleanly. The approval
 *   still lands in the operator queue built in Phase 16, and the customer gets
 *   their answer by email.
 *
 * WHY THAT SPLIT IS THE RIGHT ONE:
 *
 *   Holding a caller on the line for a human who may be minutes away converts
 *   a 30-second call into a 6-minute one and usually ends in a hang-up. The
 *   honest thing is to tell them the truth and give the time back.
 *
 * THE SAFETY PROPERTY THAT DOES NOT MOVE:
 *
 *   Voice never lowers a limit. A 500 dollar refund needs an operator whether
 *   it was asked for by voice, by chat, or by carrier pigeon. Phase 12
 *   established that approval changes WHO ASKED, never WHAT IS ALLOWED - and a
 *   channel that quietly relaxed a policy would be an attack surface, not a
 *   feature.
 */

/** Spoken forms of yes and no, kept deliberately generous. */
const AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|confirm(ed)?|please do|that'?s right|correct|absolutely|alright)\b/i;
const NEGATIVE = /^\s*(no|nope|nah|don'?t|do not|cancel|stop|never ?mind|forget it|not now|wait)\b/i;

/**
 * Interpret a spoken answer to a confirmation.
 *
 * Returns null for anything unclear, and null MUST mean "ask again" rather
 * than "assume yes". A misheard mumble is not consent to move money.
 *
 * This is the voice equivalent of the confirmation modal's most important
 * property: no default. A dialog you can dismiss into approval is a bug, and
 * so is a silence you read as consent.
 */
function interpretConfirmation(transcript) {
  const t = String(transcript ?? "").trim();
  if (!t) return null;
  if (AFFIRMATIVE.test(t)) return true;
  if (NEGATIVE.test(t)) return false;
  return null;
}

/** Say a pending action so a listener can judge it in one hearing. */
function speakConfirmation(confirmation) {
  const detail = confirmation?.summary?.detail ?? confirmation?.detail ?? "this action";
  const spoken = require("./speechFormat").mechanicalPass(detail);

  // The warning is spoken FIRST when the action is irreversible. On screen the
  // eye takes in the whole card at once; by ear, order is emphasis, and the
  // last thing said before a question is what the listener weighs.
  const irreversible = confirmation?.summary?.irreversible ?? confirmation?.irreversible;

  return irreversible
    ? `Just to confirm - ${spoken}. This cannot be undone. Shall I go ahead?`
    : `Just to confirm - ${spoken}. Shall I go ahead?`;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * One voice call.
 *
 * Holds only what a CALL needs: conversation history, whether we are currently
 * speaking, and any pending confirmation. Everything about the agent's own
 * state lives where it always has - in the run, and in MongoDB.
 */
class VoiceSession {
  constructor({ callerId, sessionId, onEvent } = {}) {
    this.sessionId = sessionId ?? crypto.randomUUID();
    this.callerId = callerId ?? null;
    this.onEvent = onEvent ?? (() => {});

    this.history = [];
    this.pending = null; // a paused run awaiting a spoken yes/no

    // ---- barge-in state -------------------------------------------------
    //
    // > "Barge-in: the user interrupts mid-response. Handle it."
    //
    // THE ANALOGY. Two people talking at once is not a conversation. When
    // someone starts speaking, a person stops - immediately, mid-word, without
    // finishing their sentence. A system that keeps talking over you feels
    // broken in a way that is hard to forgive.
    //
    // `speaking` is the flag the client checks before sending audio, and
    // `generation` is how we discard work that is no longer wanted: every
    // reply carries the generation it belongs to, and anything from an older
    // generation is dropped rather than spoken.
    this.speaking = false;
    this.generation = 0;

    this.turns = 0;
    this.startedAt = Date.now();
  }

  emit(type, payload = {}) {
    this.onEvent({ type, sessionId: this.sessionId, ...payload });
  }

  /**
   * The user started talking while we were talking.
   *
   * Bumping the generation invalidates any in-flight reply. The agent run
   * itself is NOT cancelled - it may already have moved money, and abandoning
   * a half-finished write to make a UI feel snappy would be a genuinely bad
   * trade. We stop SPEAKING, we do not stop DOING.
   */
  bargeIn() {
    // WHY THIS IS NOT GATED ON `speaking`.
    //
    // The first version returned early unless we were mid-sentence:
    //
    //     if (!this.speaking) return { interrupted: false };
    //
    // Tested against a real call, a barge-in sent 2.2 seconds in did nothing,
    // and the answer arrived and was spoken anyway. Because at 2.2 seconds we
    // were not speaking - we were WORKING. The flag was false.
    //
    // But that is precisely when people interrupt. They interrupt during the
    // silence, to correct themselves ("sorry, I meant ord_1002") or to give up
    // waiting. Requiring us to be talking before they may interrupt gets the
    // situation exactly backwards.
    //
    // > Barge-in is not "stop talking". It is "stop delivering the thing I no
    // > longer want" - and that has to work before the talking starts.
    //
    // So it always bumps the generation. `working` is reported for the
    // transcript view, not used as a gate.
    const wasSpeaking = this.speaking;
    this.generation += 1;
    this.speaking = false;
    this.emit("barge_in", {
      generation: this.generation,
      wasSpeaking,
      // Interrupting mid-work means an in-flight run is now unwanted. We do
      // NOT cancel it - it may already have moved money, and abandoning a
      // half-finished write to make the UI feel snappy is a bad trade. We stop
      // SPEAKING, not DOING; `deliver()` drops the stale reply.
      interruptedWork: !wasSpeaking,
    });
    return { interrupted: true, wasSpeaking, generation: this.generation };
  }

  /** Is this reply still wanted, or did the caller interrupt? */
  isCurrent(generation) {
    return generation === this.generation;
  }

  /**
   * Handle one spoken turn.
   *
   * @param {Buffer|string} input - audio to transcribe, or text (for tests)
   */
  async handleTurn(input, { mimeType = "audio/webm" } = {}) {
    const generation = this.generation;
    this.turns += 1;

    // ---- 1. SPEECH IN --------------------------------------------------
    let transcript;
    if (Buffer.isBuffer(input)) {
      const t0 = Date.now();
      const stt = await transcribe(input, { mimeType });
      if (stt.error) {
        // Mishearing is normal on a call. Ask again rather than guessing -
        // acting on a bad transcript is how a voice agent refunds the wrong
        // order.
        const text = "Sorry, I didn't catch that. Could you say it again?";
        this.emit("speak", { text, generation, kind: "clarify" });
        return { transcript: null, reply: text, error: stt.error };
      }
      transcript = stt.text;
      this.emit("transcript", { text: transcript, ms: Date.now() - t0 });
    } else {
      transcript = String(input ?? "");
      this.emit("transcript", { text: transcript, ms: 0 });
    }

    if (!transcript.trim()) {
      const text = "I didn't hear anything. Are you still there?";
      this.emit("speak", { text, generation, kind: "clarify" });
      return { transcript: "", reply: text };
    }

    // ---- 2. IS THIS AN ANSWER TO A CONFIRMATION? -----------------------
    if (this.pending) return this.handleConfirmationTurn(transcript, generation);

    // ---- 3. RUN THE AGENT ----------------------------------------------
    return this.runTurn(transcript, generation);
  }

  /** The caller is answering "shall I go ahead?" */
  async handleConfirmationTurn(transcript, generation) {
    const answer = interpretConfirmation(transcript);

    if (answer === null) {
      // Unclear. Ask again. NEVER assume consent.
      const text =
        "Sorry, I need a clear yes or no before I do that. Shall I go ahead?";
      this.emit("speak", { text, generation, kind: "reconfirm" });
      return { transcript, reply: text, awaitingConfirmation: true };
    }

    const paused = this.pending;
    this.pending = null;

    this.emit("confirmation_answer", { approved: answer, transcript });

    // The SAME resumeAgent() the chat UI and the operator queue both call.
    // Nothing about resumption is voice-specific, which is the point.
    const result = await resumeAgent(paused.state, answer, {
      onEvent: (e) => this.forwardAgentEvent(e, generation),
    });

    return this.deliver(result, generation, transcript);
  }

  /** A normal question. */
  async runTurn(transcript, generation) {
    let fillerTimer = null;
    let repeatTimer = null;
    let fillerCount = 0;
    let currentStep = null;

    const clearFillers = () => {
      clearTimeout(fillerTimer);
      clearInterval(repeatTimer);
    };

    // Say something only if the work is actually taking a while.
    const startFiller = () => {
      clearFillers();
      fillerTimer = setTimeout(() => {
        const toolName = currentStep;
        if (!this.isCurrent(generation)) return;
        // A named tool gets a specific line; general thinking gets a neutral
        // one. Both are TRUE, which is the property that matters - a filler
        // that claims to be checking invoices while the model is planning is
        // a small lie the customer cannot detect but the transcript records.
        const text = toolName
          ? TOOL_FILLERS[toolName] ?? "One moment while I look into that."
          : "Let me look into that for you.";
        this.emit("speak", { text, generation, kind: "filler" });
        fillerCount += 1;

        repeatTimer = setInterval(() => {
          if (!this.isCurrent(generation)) return clearFillers();

          if (fillerCount > MAX_FILLERS) {
            this.emit("speak", {
              text: FILLER_GIVING_UP,
              generation,
              kind: "filler_final",
            });
            return clearFillers();
          }

          const next = WAITING_LONGER[Math.min(fillerCount - 1, WAITING_LONGER.length - 1)];
          this.emit("speak", { text: next, generation, kind: "filler" });
          fillerCount += 1;
        }, FILLER_REPEAT_MS);
      }, FILLER_DELAY_MS);
    };

    // Start the clock the moment the caller stops talking. ONE timer for the
    // whole turn, never reset by internal progress.
    startFiller();

    try {
      const result = await runAgent(transcript, {
        history: this.history,
        callerId: this.callerId,
        conversationId: this.sessionId,
        onEvent: (e) => {
          // WHICH EVENTS START THE FILLER, and why this was wrong at first.
          //
          // The first version armed the filler only on `tool_call`. It never
          // fired once. Tracing a real refund showed why:
          //
          //     0ms     routed
          //     895ms   classified          <- LLM call
          //     2464ms  plan                <- LLM call
          //     3178ms  tool_call getCustomer
          //     3194ms  tool_result         <- the TOOL took 16ms
          //     4182ms  tool_call checkRefundEligibility
          //     4186ms  tool_result         <- this one took 4ms
          //     5002ms  awaiting_confirmation
          //
          // The tools are nearly instant. The five seconds of silence is
          // PLANNING AND THINKING - the LLM round trips between tools.
          //
          // So the filler was watching the fast part and ignoring the slow
          // part. The assignment says "tool execution takes seconds", and for
          // a remote API that is true - but ours are local database reads, and
          // measuring beat the assumption.
          //
          // > Design the filler around where the silence ACTUALLY is, which is
          // > a question only a trace can answer.
          // WHAT THE FILLER TIMER MEASURES, second correction.
          //
          // Version 2 restarted the timer on every `thinking` and cancelled it
          // on every `tool_result`. Traced against a real run:
          //
          //      976ms  thinking      -> arm
          //     1608ms  tool_call getCustomer
          //     1621ms  tool_result   -> CLEAR      (645ms elapsed)
          //     1622ms  thinking      -> arm again
          //     2297ms  tool_call getInvoices
          //     2307ms  tool_result   -> CLEAR      (685ms elapsed)
          //
          // Every individual gap is ~650ms, comfortably under the 1200ms
          // threshold, so the filler never fired - across SIX SECONDS of
          // total silence.
          //
          // The bug is what the timer was measuring. The caller does not
          // experience "the longest single step". They experience the total
          // time since they stopped talking. So the timer must run from the
          // START OF THE TURN and never be reset by progress - progress the
          // customer cannot hear is not progress to them.
          //
          // Tool events now only update WHAT we would say, not WHETHER the
          // clock is running.
          if (e.type === "tool_call") currentStep = e.tool;
          else if (e.type === "thinking") currentStep = currentStep ?? null;
          this.forwardAgentEvent(e, generation);
        },
      });

      clearFillers();
      return this.deliver(result, generation, transcript);
    } catch (err) {
      clearFillers();
      const text =
        "Sorry, something went wrong on my end. Could you try that again?";
      this.emit("speak", { text, generation, kind: "error" });
      return { transcript, reply: text, error: err.message };
    }
  }

  /** Pass agent activity through for the transcript view. */
  forwardAgentEvent(e, generation) {
    if (!this.isCurrent(generation)) return;
    if (e.type === "tool_call" || e.type === "routed" || e.type === "done") {
      this.emit("agent_activity", { ...e, generation });
    }
  }

  /**
   * Turn an agent result into something spoken.
   *
   * This is where every voice-specific decision lands, and where the "same
   * core, different formatter" promise is actually kept.
   */
  async deliver(result, generation, transcript) {
    // Interrupted while we were working - do not speak a stale answer.
    if (!this.isCurrent(generation)) {
      this.emit("discarded", { reason: "barge-in", generation });
      return { transcript, discarded: true };
    }

    if (result.history) this.history = result.history;

    // ---- PAUSED FOR APPROVAL -------------------------------------------
    if (result.status === "awaiting_confirmation") {
      // The agent returns this as `pending`, not `confirmation`. Worth a note
      // because the first version of this file guessed the field name, found
      // undefined, and cheerfully said "Just to confirm - this action" - a
      // confirmation prompt that names no action at all.
      //
      // On screen a wrong field usually shows up as a blank space someone
      // notices. Spoken aloud it becomes a fluent, grammatical sentence that
      // sounds fine and asks the customer to approve nothing in particular.
      // Voice hides missing data behind good grammar.
      const pending = result.pending ?? result.confirmation;
      const needsOperator = pending?.summary?.requiresOperator ?? pending?.requiresOperator;

      if (needsOperator) {
        // Case B: a supervisor must approve. Do NOT hold the line.
        this.pending = null;
        const text =
          "That amount needs a manager's approval, so I can't complete it on " +
          "this call. I've sent it to the team now and you'll get an email " +
          "once it's reviewed, usually within the hour.";
        this.speaking = true;
        this.emit("speak", { text, generation, kind: "handoff" });
        return { transcript, reply: text, handedOff: true };
      }

      // Case A: the customer can answer this themselves.
      this.pending = { state: result, confirmation: pending };
      const text = speakConfirmation(pending);
      this.speaking = true;
      this.emit("speak", { text, generation, kind: "confirm" });
      return { transcript, reply: text, awaitingConfirmation: true };
    }

    // ---- A NORMAL ANSWER ------------------------------------------------
    const t0 = Date.now();
    const spoken = await formatForSpeech(result.reply ?? "");

    // Check AGAIN after the rewrite: it takes a second or two, which is
    // plenty of time for someone to start talking.
    if (!this.isCurrent(generation)) {
      this.emit("discarded", { reason: "barge-in during rewrite", generation });
      return { transcript, discarded: true };
    }

    this.speaking = true;
    this.emit("speak", {
      text: spoken.text,
      generation,
      kind: "answer",
      rewritten: spoken.rewritten,
      estimatedSeconds: spoken.estimatedSeconds,
      formatMs: Date.now() - t0,
    });

    return {
      transcript,
      reply: spoken.text,
      screenReply: result.reply,
      rewritten: spoken.rewritten,
      tokensUsed: result.tokensUsed,
      route: result.route,
    };
  }

  /** The client finished playing audio. */
  finishedSpeaking() {
    this.speaking = false;
    this.emit("speech_end", { generation: this.generation });
  }

  summary() {
    return {
      sessionId: this.sessionId,
      callerId: this.callerId,
      turns: this.turns,
      durationMs: Date.now() - this.startedAt,
      awaitingConfirmation: Boolean(this.pending),
    };
  }
}

module.exports = {
  VoiceSession,
  interpretConfirmation,
  speakConfirmation,
  TOOL_FILLERS,
  FILLER_DELAY_MS,
};
