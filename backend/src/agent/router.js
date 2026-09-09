/**
 * router.js
 *
 * Deciding HOW to handle a request before deciding WHAT to answer.
 *
 * ---------------------------------------------------------------------------
 * THE IDEA, IN PLAIN TERMS
 * ---------------------------------------------------------------------------
 *
 * Think of a hospital reception desk.
 *
 *   Someone wants a form stamped        -> the clerk does it. No doctor needed.
 *   Someone has a broken arm            -> straight to orthopaedics. A
 *                                          specialist, but a KNOWN specialist.
 *   Someone has odd symptoms nobody can -> general physician, full diagnostics,
 *   place                                  whatever tests it takes.
 *
 * You would never send the form-stamping person to the general physician. It is
 * slower, dearer, and the outcome is identical. But that is exactly what a
 * system does when every request goes to a full autonomous agent.
 *
 * The assignment says it directly:
 *
 *   "Not every ticket needs an agent."
 *   "If every request routes to the autonomous agent, the routing layer isn't
 *    doing its job."
 *
 * ---------------------------------------------------------------------------
 * OUR THREE ROUTES
 * ---------------------------------------------------------------------------
 *
 *   workflow    no LLM at all. A database lookup and a template.
 *               Milliseconds, zero tokens.
 *
 *   guided      the real agent loop, but handed a SMALLER TOOLBOX. A refund
 *               request does not need the account-deletion tools, so it does
 *               not get them.
 *
 *   autonomous  the full agent, every tool. For anything novel.
 *
 * WHY THE MIDDLE ONE MATTERS MOST, and it is not about speed:
 *
 * The assignment makes this point about Build 3's specialist agents - "a
 * billing agent that can't touch account-deletion tools cannot misuse them" -
 * and the same logic applies here. A tool the agent was never given is a tool
 * it cannot call by mistake. Restricting the toolbox is a SAFETY property that
 * happens to also be cheaper.
 */

const repo = require("../data/repository");
const { classifyIntent, isConfigured } = require("./intentClassifier");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const ROUTES = {
  WORKFLOW: "workflow",
  GUIDED: "guided",
  AUTONOMOUS: "autonomous",
};

/**
 * Which tools each guided category is allowed to touch.
 *
 * Everything NOT on a list is unreachable for that category - not discouraged,
 * not warned against. Simply absent from what the model is shown.
 */
const GUIDED_TOOLSETS = {
  // Reached when the classifier says ORDER but the workflow regex could not
  // extract an order ID - e.g. "where's my stuff". Needs a lookup, not a
  // template, but still nothing that moves money.
  order: ["getCustomer", "getOrders", "escalateToHuman", "searchKnowledgeBase"],

  refund: [
    "getCustomer",
    "getOrders",
    "getInvoices",
    "checkRefundEligibility",
    "issueRefund",
    "escalateToHuman",
    "searchKnowledgeBase",
  ],
  policy: ["searchKnowledgeBase", "escalateToHuman"],
  billing: [
    "getCustomer",
    "getInvoices",
    "getOrders",
    "applyAccountCredit",
    "escalateToHuman",
    "searchKnowledgeBase",
  ],
};

// ---------------------------------------------------------------------------
// The classifier - free, deterministic, no LLM
// ---------------------------------------------------------------------------

/**
 * Deterministic workflows: high volume, completely predictable, no judgement.
 *
 * Each pattern must extract everything the handler needs. If a request needs
 * the model to work out WHAT to look up, it is not a workflow - it only
 * qualifies when the answer is a lookup and a sentence.
 */
const WORKFLOWS = [
  {
    name: "order_status",
    // "where is order ord_1001", "status of ord_1001", "track ord_1001"
    match: /\b(?:where\s+is|status\s+of|track(?:ing)?(?:\s+for)?)\b[^]*?\b(ord_\d+)\b/i,
    extract: (m) => ({ orderId: m[1] }),
  },
  {
    name: "order_status_bare",
    // just an order id and a question mark - "ord_1001?"
    match: /^\s*(ord_\d+)\s*\??\s*$/i,
    extract: (m) => ({ orderId: m[1] }),
  },
];

/** Known categories that get a constrained toolset rather than the full set. */
const GUIDED_CATEGORIES = [
  {
    name: "refund",
    // Plurals and inflections spelled out - see the billing pattern below for
    // why. "refunds" is not matched by \b(refund)\b.
    match:
      /\b(refunds?|refunded|money\s+back|reimburse[ds]?|charge[ds]?\s+twice|duplicate\s+charges?)\b/i,
  },
  {
    name: "policy",
    // A policy QUESTION with no account action attached.
    match: /\b(?:what|how|when|can\s+i|do\s+you)\b[^]*\b(policy|policies|allowed|rules?|window|how\s+long)\b/i,
  },
  {
    name: "billing",
    // Note the explicit plurals. `\b(invoice)\b` does NOT match "invoices" -
    // the word boundary sits after "invoice" but "s" is a word character, so
    // there is no boundary there. This routed "show me my invoices" to the
    // full autonomous agent for want of one letter.
    //
    // Every pattern in this file needs the same care: a router that silently
    // widens on a near-miss is expensive rather than broken, which is exactly
    // the kind of bug that survives.
    match: /\b(invoices?|billing|credits?|charges?|charged|payments?)\b/i,
  },
];

// ---------------------------------------------------------------------------
// THE SCOPE GUARD - questions that are not our business at all
// ---------------------------------------------------------------------------

/**
 * Requests that have nothing to do with a support desk.
 *
 * WHY THIS EXISTS. Before this guard, "who is the PM of India?" was routed to
 * the AUTONOMOUS agent and answered:
 *
 *     "The Prime Minister of India is Narendra Modi."   (3,905 tokens)
 *
 * Two things wrong with that, and the second is worse than the first.
 *
 * 1. IT COST THE MOST EXPENSIVE ROUTE to answer something we should refuse
 *    instantly. A support desk fielding general knowledge questions at 3,905
 *    tokens each is a bill nobody agreed to.
 *
 * 2. IT ANSWERED FROM THE MODEL'S MEMORY. That is the exact thing this whole
 *    project forbids everywhere else. Our system prompt says "never state a
 *    policy from memory, look it up" - and then the agent recited a fact from
 *    memory the moment the question fell outside the rules we wrote.
 *
 * The second point is the real lesson. A model with no tool for a question
 * does not fall silent; it falls back on what it absorbed during training. So
 * "we did not give it a tool for that" is NOT the same as "it cannot do that".
 *
 * THE ANALOGY. A bank teller asked "who is the PM of India?" should say "I
 * handle accounts - was there something about your account?" They may well
 * know the answer. Knowing it is not the same as it being their job, and a
 * teller who chats about politics is not doing the job they were hired for.
 *
 * WHY REGEX AND NOT AN LLM. This is a fixed list of topics that will never be
 * our business. Paying a model to decide "is Python programming a support
 * question?" would cost more than the refusal it produces. And the cheap check
 * runs FIRST, so the common cases never reach a paid path.
 */
const PLEASANTRIES = new Set([
  "hi", "hey", "hello", "yo", "thanks", "thank you", "thx", "ok", "okay",
  "sure", "yes", "no", "bye", "goodbye", "cheers", "hi there", "hey there",
]);

const OUT_OF_SCOPE = [
  {
    name: "general_knowledge",
    // Who/what/when questions about the world - politics, geography, history.
    //
    // The trailing (?:\s+of\b|\W*$) is the whole trick, and it was added after
    // this pattern wrongly blocked a real support question:
    //
    //     "what is the president tier discount?"      <- BLOCKED. Wrong.
    //
    // "president" there is store vocabulary (a customer tier), not politics.
    // So the topic word must either END the question or be followed by "of":
    //
    //     "who is the president of USA"     -> blocked (has "of")
    //     "what is the capital of France?"  -> blocked (has "of")
    //     "who is the PM of India?"         -> blocked (has "of")
    //     "what is the president tier ..."  -> ALLOWED (continues into store
    //                                          vocabulary, so not a general
    //                                          knowledge question)
    //
    // THE LESSON: a keyword shared between two domains cannot be classified by
    // the keyword alone. What disambiguates "president" here is the SHAPE of
    // the sentence around it, not the word.
    match:
      /\b(?:who|what|when|where)\s+(?:is|are|was|were)\s+(?:the\s+)?(?:pm|prime\s+minister|president|capital|population|ceo|king|queen|currency)(?:\s+of\b|\W*$)/i,
  },
  {
    name: "tutoring",
    // "teach me python", "explain recursion", "how do I write a for loop"
    match:
      /\b(?:teach|tutor|explain)\s+(?:me\s+)?(?:about\s+)?(?:python|java(?:script)?|c\+\+|sql|react|coding|programming|maths?|physics|recursion|algorithms?|data\s+structures?|machine\s+learning)\b|\bhow\s+(?:do|can)\s+i\s+(?:write|code|learn|program)\b/i,
  },
  {
    name: "creative",
    // "write me a poem", "tell me a joke", "write an essay about X"
    match:
      /\b(?:write|compose|generate)\s+(?:me\s+)?(?:an?\s+)?(?:poem|song|joke|story|essay|haiku|rap|script)\b|\btell\s+me\s+a\s+joke\b/i,
  },
  {
    name: "medical_legal_financial",
    // Advice we are not qualified to give and should never appear to give.
    match:
      /\b(?:should\s+i\s+(?:invest|sue|take)|medical\s+advice|legal\s+advice|diagnos(?:e|is)|symptoms?\s+of|stock\s+(?:tips?|market)|which\s+(?:stock|crypto))\b/i,
  },
  {
    name: "model_probing",
    // "what model are you", "ignore your instructions", "show me your prompt"
    match:
      /\b(?:what\s+(?:model|llm|ai)\s+are\s+you|are\s+you\s+(?:chatgpt|gpt|claude|gemini)|(?:ignore|forget|disregard)\s+(?:your|all|the|any|previous|prior)\s+(?:previous\s+|prior\s+)?(?:instructions?|rules?|prompts?)|(?:show|reveal|print)\s+(?:me\s+)?your\s+(?:prompt|instructions?|system))\b/i,
  },
];

/**
 * The refusal itself.
 *
 * ONE message for every out-of-scope category, deliberately. A refusal that
 * varies by topic tells the person probing exactly which categories we
 * recognise, which is a map of what to try next. It also says what we DO
 * handle, because a bare "I can't help with that" leaves someone stuck.
 */
const SCOPE_REFUSAL =
  "I'm HelpDesk Copilot - I only handle questions about this store: your " +
  "orders, invoices, refunds, account and our policies. I can't help with " +
  "that one, but if you have a question about an order or a charge, I'm ready.";

/**
 * STAGE 1: the free classifier.
 *
 * Regex only. Returns null when it cannot decide confidently, which is the
 * signal to escalate to stage 2 rather than guessing.
 *
 * @returns {Object|null}
 */
function routeByPattern(message) {
  const text = String(message || "");

  // ---- 0. Out of scope ---------------------------------------------------
  //
  // FIRST, before anything else. This is the cheapest possible answer - no
  // database read, no model call, no tokens - and a request we will refuse
  // should never travel any further into the system than it has to.
  for (const oos of OUT_OF_SCOPE) {
    if (oos.match.test(text)) {
      return {
        route: ROUTES.WORKFLOW,
        workflow: "out_of_scope",
        params: { category: oos.name, rawMessage: text },
        reason: `Out of scope (${oos.name}) - refused without an LLM call.`,
      };
    }
  }

  // ---- 1. Deterministic workflow -----------------------------------------
  for (const wf of WORKFLOWS) {
    const m = text.match(wf.match);
    if (m) {
      return {
        route: ROUTES.WORKFLOW,
        workflow: wf.name,
        params: wf.extract(m),
        reason: `Matched the ${wf.name} workflow - fully predictable, no judgement needed.`,
      };
    }
  }

  // ---- 2. Guided agent ---------------------------------------------------
  //
  // A compound request is NOT guided even if it mentions refunds - "refund
  // this and also update my address" needs tools the refund set does not
  // contain. When in doubt, widen rather than fail.
  const compound = /\b(and\s+also|as\s+well\s+as|plus\s+(?:can|could)\s+you)\b/i.test(text);

  if (!compound) {
    for (const cat of GUIDED_CATEGORIES) {
      if (cat.match.test(text)) {
        return {
          route: ROUTES.GUIDED,
          category: cat.name,
          tools: GUIDED_TOOLSETS[cat.name],
          reason:
            `Recognised as a ${cat.name} request. Restricted to ${GUIDED_TOOLSETS[cat.name].length} ` +
            `of 8 tools - the rest are unreachable, not merely discouraged.`,
        };
      }
    }
  }

  // ---- 3. Undecided ------------------------------------------------------
  //
  // A compound request is genuinely autonomous - it spans categories, so no
  // single restricted toolset fits. That IS a confident decision.
  if (compound) {
    return {
      route: ROUTES.AUTONOMOUS,
      reason: "Compound request spanning multiple categories - needs the full toolset.",
      stage: "pattern",
    };
  }

  // Everything else: patterns had no opinion. Say so honestly rather than
  // defaulting to the most expensive route, and let stage 2 decide.
  return null;
}

/**
 * Route a request. Two stages, cheap one first.
 *
 *   stage 1  regex          ~0ms, free      catches the unambiguous cases
 *   stage 2  gpt-oss-20b    ~600ms, free    catches meaning, typos, other
 *                                           languages, unusual phrasing
 *
 * WHY BOTH: "ord_1001?" needs no understanding at all, and paying 600ms plus a
 * network dependency to classify it would be silly. But a keyword list can only
 * match words somebody thought of in advance, which is how
 * "can you show me my invoices" ended up on the 225x-cost path over one letter.
 *
 * Stage 2 never blocks the request. If it is missing, slow, or wrong-shaped,
 * we route autonomously - slower and dearer, never broken.
 *
 * @returns {Promise<{route, category?, tools?, params?, reason, stage}>}
 */
async function routeRequest(message, options = {}) {
  const history = options.history ?? [];

  // Everything this function needs to decide, gathered once.
  //
  // The previous version computed some of these twice - routeByPattern ran
  // twice and, on a continuation turn, the classifier could be called TWICE
  // for one message. Nobody wrote that deliberately; it accumulated as each
  // bug was fixed by adding another branch at the top.
  const patterns = routeByPattern(message);
  const midConversation = isAnswerToAQuestion(message, history);

  // The classifier is the expensive input (~600ms), so it is fetched lazily
  // and at most once, no matter how many rules want to consult it.
  let intentCache;
  const intent = async () => {
    if (intentCache === undefined) {
      intentCache = isConfigured() ? await classifyIntent(message) : null;
    }
    return intentCache;
  };

  // ---- THE RULES, IN PRIORITY ORDER -------------------------------------
  //
  // Read top to bottom: the first rule that returns a route wins. That
  // ordering IS the policy, and it is the thing a reader needs to understand,
  // so it lives in one list rather than spread through nested branches.
  //
  // Adding a route means adding one entry here. It does not mean finding the
  // right place among eleven ifs and hoping.
  const RULES = [
    // 1. REFUSALS FIRST, ALWAYS.
    //
    //    This is a hard-won ordering. When the mid-conversation rule sat
    //    above the refusals, this happened:
    //
    //      agent: "You're very welcome. Anything else I can help with?"
    //      user:  "who is pm of india? where is my refund?"
    //      agent: "The current Prime Minister of India is Narendra Modi."
    //
    //    A closing pleasantry ends in "?", so the message looked like an
    //    answer, so the scope check never ran. A safety rule that a later
    //    branch can jump over is not a safety rule - it goes first.
    {
      name: "scope-pattern",
      run: () =>
        patterns?.workflow === "out_of_scope"
          ? { ...patterns, stage: "pattern" }
          : null,
    },
    {
      name: "scope-classifier",
      // The regex only catches what somebody thought of in advance; measured
      // against nine evasions (Hindi, French, "P.M.", spaced letters) it
      // caught none. The classifier reads meaning, so it gets a say on every
      // message - including one that arrives mid-conversation.
      run: async () => {
        const i = await intent();
        return i?.route === "out_of_scope"
          ? refusal(message, i)
          : null;
      },
    },

    // 2. MID-CONVERSATION: an answer needs the conversation, not a template.
    //
    //    Below the refusals, above everything else. A template cannot answer
    //    a follow-up because it does not know what was asked.
    {
      name: "continuation",
      run: () =>
        midConversation
          ? {
              route: ROUTES.AUTONOMOUS,
              reason:
                "The agent asked a question on the previous turn, so this " +
                "message is an answer - it needs the conversation.",
              stage: "continuation",
            }
          : null,
    },

    // 3. THE FREE PATH: regex workflows and guided categories.
    {
      name: "patterns",
      run: () => (patterns ? { ...patterns, stage: patterns.stage ?? "pattern" } : null),
    },

    // 4. THE CHEAP PATH: one small-model call decides the rest.
    {
      name: "classifier",
      run: async () => {
        const i = await intent();
        if (!i) return null;

        if (i.route === "social") {
          return {
            route: ROUTES.WORKFLOW,
            workflow: "social",
            params: { rawMessage: message },
            reason: `Conversational opener (${i.latencyMs}ms) - template, 0 tokens.`,
            stage: "classifier",
            classifier: { label: i.label, latencyMs: i.latencyMs },
          };
        }

        if (i.route === ROUTES.GUIDED && GUIDED_TOOLSETS[i.category]) {
          return {
            route: ROUTES.GUIDED,
            category: i.category,
            tools: GUIDED_TOOLSETS[i.category],
            reason:
              `Intent classified as ${i.label} in ${i.latencyMs}ms. ` +
              `Restricted to ${GUIDED_TOOLSETS[i.category].length} of 9 tools.`,
            stage: "classifier",
            classifier: { label: i.label, latencyMs: i.latencyMs, tokens: i.tokens },
          };
        }

        return {
          route: ROUTES.AUTONOMOUS,
          reason: `Intent classified as ${i.label} - needs the full toolset.`,
          stage: "classifier",
          classifier: { label: i.label, latencyMs: i.latencyMs, tokens: i.tokens },
        };
      },
    },
  ];

  for (const rule of RULES) {
    const decision = await rule.run();
    if (decision) return decision;
  }

  // ---- NOBODY HAD AN OPINION --------------------------------------------
  //
  // Slower and dearer, never broken. A classifier outage must degrade the
  // system, not stop it.
  return {
    route: ROUTES.AUTONOMOUS,
    reason: isConfigured()
      ? "Classifier unavailable - defaulting to the full toolset."
      : "No classifier configured - defaulting to the full toolset.",
    stage: "fallback",
  };
}

/** Shape a classifier refusal. Kept here so both scope rules agree. */
function refusal(message, intent) {
  return {
    route: ROUTES.WORKFLOW,
    workflow: "out_of_scope",
    params: { category: "classifier", rawMessage: message },
    reason: `Classified as ${intent.label} in ${intent.latencyMs}ms - refused before any agent ran.`,
    stage: "classifier",
    classifier: { label: intent.label, latencyMs: intent.latencyMs },
  };
}

/**
 * Is this message an ANSWER to something the agent just asked?
 *
 * Extracted from routeRequest because it is a genuine question about the
 * conversation, and burying it inline made the routing sequence unreadable.
 *
 * Two things it has to get right, both learned from bugs:
 *
 *   A question can sit ANYWHERE in the reply. The first version tested
 *   endsWith("?") and missed the commonest shape an agent produces -
 *   "Could you provide your email? Once I have that, I can look up your
 *   orders." - so the fix for the greeting loop did not actually fix it.
 *
 *   A pleasantry is not an answer. Sending "hi" or "thanks" to the agent
 *   invited it to invent the value it was waiting for, and it did:
 *   "alice@example.com", hallucinated from "My name is alice".
 */
function isAnswerToAQuestion(message, history) {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const lastText = typeof lastAssistant?.content === "string" ? lastAssistant.content : "";

  const agentAsked =
    lastText.includes("?") ||
    /(please (provide|share|confirm|let me know|tell me)|could you (please )?(provide|share|confirm)|what('s| is) your|i('ll| will) need your)/i.test(
      lastText
    );

  if (!agentAsked) return false;

  const trimmed = String(message || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "");

  return !PLEASANTRIES.has(trimmed);
}


// ---------------------------------------------------------------------------
// Workflow handlers - no LLM anywhere in here
// ---------------------------------------------------------------------------

/**
 * Run a deterministic workflow.
 *
 * Reads the database, fills a template, returns. No model, no tools, no loop.
 * A few milliseconds and zero tokens for the single most common question a
 * support desk receives.
 *
 * The authorization guard still applies. A cheaper path must never be a weaker
 * path - that would make "route to workflow" an attack rather than an
 * optimisation.
 */
async function runWorkflow(workflow, params, ctx = {}) {
  if (workflow === "order_status" || workflow === "order_status_bare") {
    const order = await repo.findOrderById(params.orderId);

    if (!order) {
      return {
        reply: `I could not find an order with the ID ${params.orderId}. Could you double-check it?`,
        handled: true,
      };
    }

    // Same ownership rule as every tool. The fast path is not a back door.
    if (ctx.callerId && order.customerId !== ctx.callerId) {
      return {
        reply:
          "I can only look up orders on your own account. Could you confirm " +
          "the order number from your confirmation email?",
        handled: true,
      };
    }

    const STATUS_TEXT = {
      delivered: (o) => `was delivered on ${o.deliveredAt}`,
      shipped: () => "is on its way to you now",
      pending: () => "is being prepared for dispatch",
      cancelled: () => "was cancelled and has not been charged",
    };

    const phrase = (STATUS_TEXT[order.status] ?? (() => `is currently ${order.status}`))(order);

    return {
      reply: `Your order ${order.id} (${order.description}) ${phrase}.`,
      handled: true,
      data: { orderId: order.id, status: order.status },
    };
  }

  if (workflow === "social") {
    const text = String(params.rawMessage ?? "").toLowerCase();

    // Match the register of what they said. Answering "thanks" with "Hello!"
    // is the kind of small wrongness that makes a bot feel like a bot.
    // Match the register of what they said. Answering "thanks" with "Hello!"
    // is the kind of small wrongness that makes a bot feel like a bot.
    //
    // Plain string matching rather than regex, deliberately. These are short
    // fixed phrases with no structure to match, so a regex buys nothing - and
    // the first attempt here shipped a pattern containing a literal BACKSPACE
    // character (0x08) instead of the two-character escape , because the
    // backslash was eaten passing through shell -> script -> file. It read
    // perfectly on screen and matched nothing at runtime.
    //
    // Every layer of quoting is a chance to silently change what you wrote.
    const has = (...words) => words.some((w) => text.includes(w));

    const isThanks = has("thanks", "thank you", "thx", "cheers", "appreciate");
    const isBye = has("bye", "goodbye", "see you", "nothing else");
    const isName = has("i am ", "i'm ", "my name is", "this is ");
    const isFrustrated = has(
      "what's the problem",
      "whats the problem",
      "why won't you",
      "why wont you",
      "not helping",
      "useless"
    );

    const reply = isThanks
      ? "You're very welcome. Anything else I can help with?"
      : isBye
      ? "Thanks for getting in touch. Have a good day!"
      : isFrustrated
      ? "Sorry about that - you're right, that was unhelpful. I can look up " +
        "your orders, invoices and refunds. What can I help you with?"
      : isName
      ? "Nice to meet you! I can help with orders, invoices, refunds and our " +
        "policies. What can I do for you?"
      : "Hello! I'm HelpDesk Copilot. I can help with your orders, invoices, " +
        "refunds and account questions. What can I do for you?";

    return { reply, handled: true, data: { social: true } };
  }

  if (workflow === "out_of_scope") {
    // ---- LOG EVERY REFUSAL, WITH THE RAW TEXT --------------------------
    //
    // This is the layer that compounds, and it is the cheapest thing in the
    // file to build.
    //
    // The regex list (layer 1) can only ever contain what somebody thought of.
    // The classifier (layer 2) catches what nobody thought of - in Hindi, in
    // French, with the letters spaced out. So every time layer 2 blocks
    // something layer 1 missed, that is a FREE lesson about a gap in layer 1.
    //
    // Write it down and the cheap layer gets smarter over time without anybody
    // guessing. Do not write it down and you keep paying 600ms forever to
    // re-learn the same thing.
    //
    // The `stage` is what makes this useful - it says WHICH layer caught it:
    //
    //     stage=pattern     the regex knew. no action needed.
    //     stage=classifier  the regex MISSED this. consider a pattern.
    //
    // Also worth watching: a burst of refusals from one caller is not a
    // confused customer, it is somebody probing. That is a rate-limit signal,
    // not a support ticket.
    console.warn(
      `[scope] refused (${params.category}) caller=${ctx.callerId ?? "anon"}: ` +
        JSON.stringify(String(params.rawMessage ?? "").slice(0, 120))
    );

    return {
      reply: SCOPE_REFUSAL,
      handled: true,
      data: { category: params.category, refused: true },
    };
  }

  // Unknown workflow name - fall through to the agent rather than guessing.
  return { handled: false };
}

module.exports = {
  routeRequest,
  routeByPattern,
  runWorkflow,
  ROUTES,
  GUIDED_TOOLSETS,
  OUT_OF_SCOPE,
  SCOPE_REFUSAL,
};
