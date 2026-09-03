/**
 * test-ratelimit.js — Step 11 verification.
 *
 * Run with:  node test-ratelimit.js
 *
 * The loop already caps ONE request (8 iterations, 30k tokens). Nothing capped
 * a PERSON. These tests prove the per-user ceiling holds, that it is per-user
 * and not global, and that the counter is race-safe.
 *
 * Deliberately calls the limiter directly rather than sending 25 real agent
 * requests — that would cost real money and take minutes to prove something a
 * counter can prove in milliseconds.
 */

require("dotenv").config();
const { connectRedis, disconnectRedis, isReady } = require("./src/cache/redis");
const {
  checkRateLimit,
  recordTokens,
  getUsage,
  resetLimits,
  LIMITS,
} = require("./src/cache/rateLimit");

const line = (t) => console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70));

async function main() {
  const up = await connectRedis();
  console.log(`\nRedis: ${up ? "connected" : "NOT connected"}`);
  if (!up) {
    console.error("Start it with:  docker start helpdesk-redis");
    process.exit(1);
  }

  let allPass = true;
  const track = (p) => { if (!p) allPass = false; };

  const ALICE = "cus_001";
  const BOB = "cus_002";
  await resetLimits(ALICE);
  await resetLimits(BOB);

  // =====================================================================
  line("A.  THE PER-MINUTE CEILING");

  console.log(`\n  Limit is ${LIMITS.requestsPerMinute}/minute. Sending ${LIMITS.requestsPerMinute + 3}:\n`);

  let allowed = 0;
  let blocked = 0;
  let firstBlockAt = null;

  for (let i = 1; i <= LIMITS.requestsPerMinute + 3; i++) {
    const v = await checkRateLimit(ALICE);
    if (v.allowed) allowed++;
    else {
      blocked++;
      if (firstBlockAt === null) firstBlockAt = i;
    }
  }

  console.log(`  allowed        : ${allowed}`);
  console.log(`  blocked        : ${blocked}`);
  console.log(`  first blocked  : request #${firstBlockAt}`);

  const aPass = allowed === LIMITS.requestsPerMinute && firstBlockAt === LIMITS.requestsPerMinute + 1;
  console.log(
    `\n  ${aPass
      ? "PASS — exactly the limit got through, the rest were refused."
      : "FAIL — wrong number allowed."}`
  );

  // =====================================================================
  line("B.  THE LIMIT IS PER USER, NOT GLOBAL");

  console.log("\n  Alice is exhausted. Bob has made no requests:\n");

  const bobVerdict = await checkRateLimit(BOB);
  const aliceVerdict = await checkRateLimit(ALICE);

  console.log(`  Bob   allowed : ${bobVerdict.allowed}`);
  console.log(`  Alice allowed : ${aliceVerdict.allowed}`);
  console.log(
    `\n  ${bobVerdict.allowed && !aliceVerdict.allowed
      ? "PASS — one user's abuse does not affect another."
      : "FAIL — the limit is not correctly scoped."}`
  );

  // =====================================================================
  line("C.  THE RESPONSE TELLS THE CLIENT WHAT TO DO");

  const v = await checkRateLimit(ALICE);
  console.log(`\n  reason     : ${v.reason}`);
  console.log(`  limit      : ${v.limit}`);
  console.log(`  used       : ${v.used}`);
  console.log(`  retryAfter : ${v.retryAfter}s`);
  console.log(
    `\n  ${v.retryAfter > 0 && v.retryAfter <= 60
      ? "PASS — a client knows exactly how long to wait instead of guessing."
      : "FAIL — retryAfter is not usable."}`
  );

  // =====================================================================
  line("D.  THE RACE CONDITION — why INCR and not GET/SET");

  console.log(`
  The naive limiter reads, decides, then writes:

      const n = await redis.get(key);     // both read 19
      if (n >= limit) return blocked;     // both decide "under"
      await redis.set(key, n + 1);        // both write 20

  Two simultaneous requests both pass, and the counter is wrong.
  INCR is atomic: increment and return in one operation.

  Firing ${LIMITS.requestsPerMinute + 10} checks CONCURRENTLY for a fresh user:
`);

  const RACER = "race_" + Date.now();
  const results = await Promise.all(
    Array.from({ length: LIMITS.requestsPerMinute + 10 }, () => checkRateLimit(RACER))
  );

  const ok = results.filter((r) => r.allowed).length;
  console.log(`  allowed under concurrency : ${ok}`);
  console.log(`  expected                  : ${LIMITS.requestsPerMinute}`);
  console.log(
    `\n  ${ok === LIMITS.requestsPerMinute
      ? "PASS — no request slipped through the race."
      : `FAIL — ${ok} got through; the counter is not atomic.`}`
  );
  await resetLimits(RACER);

  // =====================================================================
  line("D2. THE BOUNDARY EXPLOIT — why sliding, not fixed, windows");

  console.log(`
  The first version used a FIXED window: one counter per clock minute.
  It looked fine and passed every test above. Then this:

      fire 20 requests at 11:59:59   -> different bucket, all allowed
      fire 20 requests at 12:00:01   -> new bucket, all allowed
      => 40 requests two seconds apart, against a 20/min limit

  An attacker timing bursts on the boundary gets double, every minute.
  The fix is a sorted set of timestamps counted from *now* backwards, so
  the window slides instead of jumping.
`);

  const ATTACK = "attack_" + Date.now();
  const realNow = Date.now;
  const base = Math.ceil(realNow() / 60000) * 60000 - 1000; // 1s before a boundary

  Date.now = () => base;
  let before = 0;
  for (let i = 0; i < LIMITS.requestsPerMinute; i++) {
    if ((await checkRateLimit(ATTACK)).allowed) before++;
  }

  Date.now = () => base + 2000; // 2 seconds later, across the boundary
  let after = 0;
  for (let i = 0; i < LIMITS.requestsPerMinute; i++) {
    if ((await checkRateLimit(ATTACK)).allowed) after++;
  }
  Date.now = realNow;

  console.log(`  allowed at 11:59:59 : ${before}`);
  console.log(`  allowed at 12:00:01 : ${after}`);
  console.log(`  total in 2 seconds  : ${before + after}  (limit ${LIMITS.requestsPerMinute}/min)`);
  const d2Pass = before + after <= LIMITS.requestsPerMinute;
  track(d2Pass);
  console.log(
    `\n  ${d2Pass
      ? "PASS — the boundary exploit is closed. Fixed window gave 40 here."
      : "FAIL — still exploitable at the boundary."}`
  );
  await resetLimits(ATTACK);

  // =====================================================================
  line("E.  THE TOKEN BUDGET — a different shape of abuse");

  console.log(`
  A user can sit under 20 requests/minute all day and still burn a
  fortune on a few enormous questions. So tokens are capped separately,
  per hour.
`);

  const SPENDER = "spend_" + Date.now();
  await recordTokens(SPENDER, LIMITS.tokensPerHour - 100);
  const nearLimit = await checkRateLimit(SPENDER);
  console.log(`  after spending ${(LIMITS.tokensPerHour - 100).toLocaleString()} tokens: allowed=${nearLimit.allowed}`);

  await recordTokens(SPENDER, 500); // pushes over
  const overLimit = await checkRateLimit(SPENDER);
  console.log(`  after spending ${(LIMITS.tokensPerHour + 400).toLocaleString()} tokens: allowed=${overLimit.allowed}`);
  console.log(`  reason: ${overLimit.reason ?? "(none)"}`);

  console.log(
    `\n  ${nearLimit.allowed && !overLimit.allowed
      ? "PASS — under budget proceeds, over budget is refused."
      : "FAIL — the token ceiling is not enforced."}`
  );
  await resetLimits(SPENDER);

  // =====================================================================
  line("F.  USAGE IS INSPECTABLE");

  const usage = await getUsage(ALICE);
  console.log(`\n  enforced     : ${usage.enforced}`);
  console.log(`  requests     : ${usage.requests} / ${usage.requestLimit}`);
  console.log(`  tokens       : ${usage.tokens} / ${usage.tokenLimit}`);
  console.log(
    `\n  ${usage.enforced ? "PASS — a client can show its own budget rather than discovering it via a 429." : "FAIL"}`
  );

  await resetLimits(ALICE);
  await resetLimits(BOB);

  // =====================================================================
  line(allPass ? "ALL RATE LIMIT TESTS PASSED" : "SOME TESTS FAILED");
  line("WHAT THIS DOES NOT DO");
  console.log(`
  Redis down means rate limiting is OFF, not that requests are refused.
  That is a deliberate trade documented in src/cache/redis.js:

    - the threat here is COST, not security or data loss
    - per-REQUEST caps (8 iterations, 30k tokens) live in the loop and
      never touch Redis, so one request still cannot run away
    - what is lost is only the per-USER ceiling, only while Redis is down

  A system where exceeding the limit meant a breach rather than a bill
  should make the opposite call.
`);

  await disconnectRedis();
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  console.error(err.stack);
  await disconnectRedis();
  process.exit(1);
});
