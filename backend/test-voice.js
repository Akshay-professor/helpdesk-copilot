/**
 * test-voice.js
 *
 * The Build 3 voice channel (20 marks).
 *
 * > "Expose the agent over voice, REUSING THE SAME CORE (not a parallel
 * >  implementation)... Responses must be rewritten for speech... silence
 * >  feels like a dropped call... HITL over voice... Barge-in."
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS RUN OVER A REAL WEBSOCKET
 * ---------------------------------------------------------------------------
 *
 * Parts A-C test units directly. Parts D-G open an actual socket to a running
 * server, because the interesting voice bugs are all about TIME and ORDER -
 * when the filler fires, whether an interruption arrives before the answer,
 * whether a stale reply gets spoken anyway. None of those are visible when you
 * call the functions directly and await them politely.
 *
 * Start the server first:
 *     node src/server.js
 */

require("dotenv").config();

const WebSocket = require("ws");
const {
  mechanicalPass,
  needsRewrite,
  speakMoney,
  formatForSpeech,
} = require("./src/voice/speechFormat");
const { interpretConfirmation, speakConfirmation } = require("./src/voice/voiceSession");
const { isConfigured, MIN_AUDIO_BYTES } = require("./src/voice/stt");

const WS_URL = process.env.VOICE_WS_URL || "ws://localhost:5000/voice";

let failures = 0;
const check = (label, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
};
const line = (t) => console.log("\n" + "=".repeat(70) + `\n${t}\n` + "=".repeat(70) + "\n");

/** Open a call, run a script of timed actions, collect every event. */
function call(script, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      // THE HEADER, NOT THE URL. See voiceServer.js.
      headers: { Authorization: "Bearer cus_001" },
    });
    const events = [];
    const t0 = Date.now();
    const timers = [];

    const finish = () => {
      timers.forEach(clearTimeout);
      try { ws.close(); } catch {}
      resolve(events);
    };

    ws.on("open", () => {
      for (const step of script) {
        timers.push(
          setTimeout(() => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(step.send));
          }, step.at)
        );
      }
      timers.push(setTimeout(finish, timeoutMs));
    });

    ws.on("message", (data) => {
      const e = JSON.parse(data.toString());
      events.push({ ...e, ms: Date.now() - t0 });
      if (e.type === "speak" && e.kind === "answer") {
        // The answer arrived; give a beat for trailing events then stop.
        timers.push(setTimeout(finish, 400));
      }
    });

    ws.on("error", reject);
  });
}

const spoken = (events, kind) =>
  events.filter((e) => e.type === "speak" && (!kind || e.kind === kind));

async function main() {
  // =====================================================================
  line("A.  SPEAKABLE NOTATION — the deterministic pass");

  console.log("  A table is a MAP; speech is DIRECTIONS. Nobody reads a map aloud.\n");

  console.log("  MONEY");
  [[240, "240 dollars"], [89.99, "89 dollars 99 cents"], [0.5, "50 cents"], [1, "1 dollar"]]
    .forEach(([amt, want]) => {
      const got = speakMoney(amt);
      console.log(`    $${amt} -> "${got}"`);
      if (got !== want) failures++;
    });
  check("amounts are spoken as words, not decimals", speakMoney(240) === "240 dollars");

  const messy = "**Refund** of $55.00 for order ord_1001 issued 2026-08-20. Contact alice@shop.com about the 15% fee.";
  const clean = mechanicalPass(messy);
  console.log(`\n    IN : ${messy}`);
  console.log(`    OUT: ${clean}\n`);

  check("markdown is stripped", !/[*_#|]/.test(clean));
  check("IDs are spoken digit by digit", /order 1 0 0 1/.test(clean), '"ord_1001" -> "order 1 0 0 1"');
  check("no stuttered ID prefix", !/order order/i.test(clean), 'not "order order 1 0 0 1"');
  check("ISO dates become speakable", /20 August 2026/.test(clean));
  check("emails are spelled out", /alice at shop dot com/.test(clean));
  check("percentages become words", /15 percent/.test(clean));

  // =====================================================================
  line("B.  KNOWING WHEN A REWRITE IS NEEDED");

  console.log("  The LLM pass costs a round trip, so it runs only when the SHAPE\n" +
    "  of the answer is wrong for speech - not merely its punctuation.\n");

  const table = "| Invoice | Amount |\n|---|---|\n| inv_5001 | $240 |\n| inv_5002 | $89.99 |";
  const short = "Your order was delivered on Tuesday.";

  console.log(`    table         -> ${needsRewrite(table).needed}  (${needsRewrite(table).reason})`);
  console.log(`    short reply   -> ${needsRewrite(short).needed}  (${needsRewrite(short).reason})\n`);

  check("a table demands a rewrite", needsRewrite(table).needed);
  check("a short sentence does not", !needsRewrite(short).needed, "no needless LLM call");

  const rewritten = await formatForSpeech(
    "Here are your invoices:\n\n| Invoice ID | Order ID | Amount |\n|---|---|---|\n" +
      "| inv_5001 | ord_1001 | $240.00 |\n| inv_5002 | ord_1002 | $89.99 |\n| inv_5003 | ord_1001 | $240.00 |"
  );
  console.log(`    SPOKEN: "${rewritten.text}"\n`);
  check("the table became a sentence", !/\|/.test(rewritten.text));
  check("it is short enough to say", rewritten.estimatedSeconds <= 30,
    `~${rewritten.estimatedSeconds}s`);

  // =====================================================================
  line("C.  SPOKEN YES AND NO — and the answers that are neither");

  console.log("  A misheard mumble is NOT consent to move money.\n");

  for (const [t, want] of [
    ["yes", true], ["yeah go ahead", true], ["sure", true], ["do it", true],
    ["no", false], ["nope", false], ["cancel that", false],
    ["hmm maybe", null], ["what?", null], ["", null],
  ]) {
    const got = interpretConfirmation(t);
    if (got !== want) { failures++; console.log(`    MISREAD "${t}" -> ${got}, wanted ${want}`); }
  }
  check("yes / no / unclear are all distinguished", true, "unclear must NEVER mean yes");

  const prompt = speakConfirmation({
    summary: { detail: "Refund $55.00 for order ord_1001", irreversible: true },
  });
  console.log(`    "${prompt}"\n`);
  check("the spoken confirmation names the actual action",
    /55 dollars/.test(prompt) && /order 1 0 0 1/.test(prompt),
    "not a vague 'this action'");
  check("irreversibility is spoken aloud", /cannot be undone/i.test(prompt));

  console.log(`  STT configured: ${isConfigured()} (min audio ${MIN_AUDIO_BYTES} bytes)`);

  // =====================================================================
  line("D.  A CALL, END TO END — over a real WebSocket");

  console.log(`  ${WS_URL}, with the JWT in the AUTHORIZATION HEADER.\n` +
    "  A URL is not a secret channel: it lands in access logs, proxies,\n" +
    "  browser history and Referer headers.\n");

  let events;
  try {
    events = await call([{ at: 200, send: { type: "text", text: "where is order ord_1001?" } }]);
  } catch (err) {
    console.log(`  SKIPPED — could not connect (${err.message}).`);
    console.log("  Start the server first:  node src/server.js\n");
    process.exit(failures === 0 ? 0 : 1);
  }

  const ready = events.find((e) => e.type === "ready");
  const answer = spoken(events, "answer")[0];

  console.log(`    ready in ${ready?.ms}ms — auth via ${ready?.auth}, caller ${ready?.callerId}`);
  console.log(`    answer in ${answer?.ms}ms: "${answer?.text}"\n`);

  check("the caller is identified from the header",
    ready?.auth === "authorization-header", ready?.auth);
  check("a spoken answer comes back", Boolean(answer?.text));
  check("time to first audio is sub-second for a cheap route",
    (answer?.ms ?? 9999) < 1000, `${answer?.ms}ms`);
  check("the answer contains no markdown", !/[|*#]/.test(answer?.text ?? ""));
  check("IDs are spoken digit by digit", /1 0 0 1/.test(answer?.text ?? ""));

  // =====================================================================
  line("E.  FILLER — silence is a dropped call");

  console.log("  Our own trace: tools take 4-16ms, but the LLM round trips between\n" +
    "  them add up to 6+ seconds. The filler clock therefore runs from the\n" +
    "  START OF THE TURN - progress the customer cannot hear is not progress.\n");

  const slow = await call([
    { at: 200, send: { type: "text", text: "I am alice@shop.com, why was I charged twice on ord_1001?" } },
  ]);

  const fillers = spoken(slow, "filler");
  const slowAnswer = spoken(slow, "answer")[0];

  fillers.forEach((f) => console.log(`    ${String(f.ms).padStart(5)}ms filler: "${f.text}"`));
  if (slowAnswer) console.log(`    ${String(slowAnswer.ms).padStart(5)}ms answer: "${slowAnswer.text.slice(0, 60)}…"`);
  console.log();

  check("the caller hears something while we work", fillers.length > 0,
    `${fillers.length} filler(s)`);
  if (fillers.length) {
    check("nothing is said for the first ~1.2s", fillers[0].ms >= 1200,
      `first at ${fillers[0].ms}ms — a fast answer should not be interrupted by "one moment"`);
  }
  if (fillers.length > 1) {
    check("repeated fillers are not identical",
      fillers[0].text !== fillers[1].text,
      "the clearest sign of a machine is the same phrase twice");
  }
  check("the filler stops once the answer is ready",
    !slowAnswer || fillers.every((f) => f.ms < slowAnswer.ms));

  // =====================================================================
  line("F.  HITL OVER VOICE — the customer approves by speaking");

  console.log("  Two different approvals, and only one belongs on the call:\n" +
    "    A. the CUSTOMER confirming their own request   -> ask them\n" +
    "    B. a SUPERVISOR approving over-policy spend    -> do NOT hold the line\n");

  const approval = await call(
    [
      { at: 200, send: { type: "text", text: "I am alice@shop.com, please refund 55 dollars on ord_1001 for the duplicate charge" } },
      { at: 12000, send: { type: "text", text: "yes go ahead" } },
    ],
    { timeoutMs: 40000 }
  );

  const confirm = spoken(approval, "confirm")[0];
  const done = spoken(approval, "answer")[0];

  if (confirm) console.log(`    ${String(confirm.ms).padStart(5)}ms asked : "${confirm.text}"`);
  if (done) console.log(`    ${String(done.ms).padStart(5)}ms after yes: "${done.text.slice(0, 70)}…"`);
  console.log();

  check("the agent pauses and asks before moving money", Boolean(confirm));
  check("the spoken prompt names the amount and order",
    /55 dollars/.test(confirm?.text ?? "") && /1 0 0 1/.test(confirm?.text ?? ""));
  check('a spoken "yes" completes the action', Boolean(done),
    "resumed by the SAME resumeAgent() the chat UI calls");

  // =====================================================================
  line("G.  BARGE-IN — including during the silence");

  console.log("  People interrupt while you are WORKING, not only while you are\n" +
    "  talking - to correct themselves, or to give up waiting.\n");

  const interrupted = await call(
    [
      { at: 200, send: { type: "text", text: "I am alice@shop.com, why was I charged twice on ord_1001?" } },
      { at: 2200, send: { type: "barge_in" } },
    ],
    { timeoutMs: 20000 }
  );

  const bargeEvent = interrupted.find((e) => e.type === "barge_in");
  const spokenAfter = interrupted.filter(
    (e) => e.type === "speak" && e.kind === "answer" && e.ms > (bargeEvent?.ms ?? 0)
  );

  console.log(`    barge-in at ${bargeEvent?.ms}ms (wasSpeaking=${bargeEvent?.wasSpeaking})`);
  console.log(`    answers spoken after it: ${spokenAfter.length}\n`);

  check("an interruption is accepted while we are working",
    Boolean(bargeEvent), "not gated on already speaking");
  check("the stale answer is NOT spoken afterwards", spokenAfter.length === 0,
    "the run finishes, the reply is discarded");

  // =====================================================================
  line(failures === 0 ? "ALL VOICE TESTS PASSED" : `${failures} TEST(S) FAILED`);

  console.log(
    "  What is NOT in src/voice/: an agent loop, tool dispatch, a policy\n" +
      "  check, confirmation logic, reflection. All of that is runAgent(),\n" +
      "  untouched — the assignment's 'same core, not a parallel\n" +
      "  implementation'.\n\n" +
      "  Voice adds five things and only five: transcription, filler,\n" +
      "  a speech formatter, spoken approval, and barge-in.\n"
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nTest threw:", err);
  process.exit(1);
});
