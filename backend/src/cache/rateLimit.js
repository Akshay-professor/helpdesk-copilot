/**
 * rateLimit.js
 *
 * Per-user request ceilings.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ADDS THAT WE DID NOT ALREADY HAVE
 * ---------------------------------------------------------------------------
 *
 * The loop already caps a single request: 8 iterations, 30,000 tokens. One
 * request cannot run away.
 *
 * Nothing capped a PERSON. Fifty requests, each perfectly well behaved, still
 * costs fifty requests' worth of tokens. The assignment names this exactly:
 * "agent calls are expensive - an unbounded loop is a real cost incident."
 *
 * Two limits, because they catch different shapes of abuse:
 *
 *   requests/minute  ->  a script hammering the endpoint
 *   tokens/hour      ->  a slow drip of very expensive questions
 *
 * A user could sit under the per-minute limit all day and still burn a fortune;
 * a user could send one enormous request that trips nothing per-minute. Same
 * reasoning as capping both iterations AND tokens inside the loop.
 *
 * ---------------------------------------------------------------------------
 * WHY REDIS AND NOT A JAVASCRIPT MAP
 * ---------------------------------------------------------------------------
 *
 * An in-process counter is wrong in two ways that only show up in production:
 *
 *   1. It resets on restart. Deploy during an abuse spike and the attacker's
 *      budget is refilled.
 *   2. It is not shared. Two servers behind a load balancer means each keeps
 *      its own count, so every user silently gets DOUBLE the limit. Ten
 *      servers, ten times the limit.
 *
 * Redis is one shared counter every instance reads and writes.
 */

const { getClient, isReady } = require("./redis");

/**
 * The limits.
 *
 * Deliberately generous - the goal is stopping runaway cost, not policing
 * normal use. A real support conversation is a handful of messages; 20 a
 * minute is far beyond that while still catching a script.
 */
const LIMITS = {
  requestsPerMinute: 20,
  tokensPerHour: 200000,
};

/** How we identify an anonymous caller when there is no callerId. */
const ANON = "anon";

/**
 * Check whether a caller may make another request, and count it if so.
 *
 * ATOMICITY MATTERS HERE. The naive version is:
 *
 *     const n = await redis.get(key);        // read
 *     if (n >= limit) return blocked;        // decide
 *     await redis.set(key, n + 1);           // write
 *
 * Two simultaneous requests both read 19, both decide they are under 20, and
 * both write 20. The counter is wrong and the limit was exceeded. That is a
 * race condition, and it is the classic one.
 *
 * The fix is to make counting and recording one indivisible operation - here a
 * MULTI containing the whole read-modify-write. Record FIRST, compare
 * afterwards, so two racing requests see 20 and 21 and exactly one is blocked.
 *
 * See the sliding-window comment inside for the SECOND bug this had, which
 * atomicity alone does not fix.
 *
 * @param {string} callerId
 * @returns {Promise<{allowed: boolean, reason?: string, retryAfter?: number,
 *                    limit?: number, used?: number, enforced: boolean}>}
 */
async function checkRateLimit(callerId) {
  const redis = getClient();

  // Fail open, loudly. See the reasoning in redis.js - the threat here is cost,
  // and the per-request caps in the loop still hold without Redis.
  if (!redis) {
    return { allowed: true, enforced: false };
  }

  const id = callerId || ANON;
  const now = Date.now();
  const key = `rl:req:${id}`;

  try {
    // ---- SLIDING WINDOW ----------------------------------------------
    //
    // The obvious implementation is a FIXED window: one counter per clock
    // minute, `INCR` it, compare. We built that first, and it is broken in a
    // way that only shows up at the boundary. Measured:
    //
    //     filled the 12:00 window        -> 20 allowed, 21st blocked
    //     clock ticks to 12:01           -> 20 more allowed
    //     => 40 requests in 61 seconds against a 20/min limit
    //
    // A burst straddling the boundary gets nearly double the limit, and an
    // attacker who times it that way gets it every minute.
    //
    // A sliding window fixes this by storing a TIMESTAMP per request in a
    // sorted set and counting only the last 60 seconds from *now* - so the
    // window moves with the clock instead of jumping.
    //
    // The four commands run in one MULTI so they are atomic together. Without
    // that, two concurrent requests could both count before either added
    // itself, and both would be allowed.
    const windowStart = now - 60000;
    const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;

    const [, , count] = await redis
      .multi()
      .zRemRangeByScore(key, 0, windowStart) // drop entries older than 60s
      .zAdd(key, { score: now, value: member }) // record this request
      .zCard(key) // how many remain in the window
      .expire(key, 120) // let idle keys disappear
      .exec();

    if (count > LIMITS.requestsPerMinute) {
      // Remove our own entry - a blocked request should not count against the
      // window, or a client that keeps retrying while blocked would keep
      // pushing its own reset time further away.
      await redis.zRem(key, member);

      // When does the OLDEST request in the window expire? That is the exact
      // moment a slot frees up.
      const oldest = await redis.zRangeWithScores(key, 0, 0);
      const freesAt = oldest.length ? oldest[0].score + 60000 : now + 60000;
      const retryAfter = Math.max(1, Math.ceil((freesAt - now) / 1000));

      return {
        allowed: false,
        enforced: true,
        reason: "too_many_requests",
        retryAfter,
        limit: LIMITS.requestsPerMinute,
        used: count - 1,
      };
    }

    // Token budget for the hour. Read-only here; the loop reports actual usage
    // afterwards via recordTokens(), because we cannot know the cost of a
    // request until it has run.
    const hourKey = `rl:tok:${id}:${Math.floor(Date.now() / 3600000)}`;
    const spent = Number((await redis.get(hourKey)) || 0);

    if (spent >= LIMITS.tokensPerHour) {
      const ttl = await redis.ttl(hourKey);
      return {
        allowed: false,
        enforced: true,
        reason: "token_budget_exhausted",
        retryAfter: ttl > 0 ? ttl : 3600,
        limit: LIMITS.tokensPerHour,
        used: spent,
      };
    }

    return {
      allowed: true,
      enforced: true,
      used: count,
      limit: LIMITS.requestsPerMinute,
      tokensUsed: spent,
      tokenLimit: LIMITS.tokensPerHour,
    };
  } catch (err) {
    console.warn(`[ratelimit] check failed (${err.message}) — allowing.`);
    return { allowed: true, enforced: false };
  }
}

/**
 * Record what a finished request actually cost.
 *
 * Called AFTER the run, because the cost is unknown until then. This means a
 * user can always exceed the hourly budget by the size of their last request -
 * accepted deliberately: the alternative is refusing to start any request that
 * *might* be expensive, which would refuse almost everything.
 *
 * Never throws. A failed accounting write must not fail the customer's request.
 */
async function recordTokens(callerId, tokens) {
  const redis = getClient();
  if (!redis || !tokens) return;

  const id = callerId || ANON;
  const hourKey = `rl:tok:${id}:${Math.floor(Date.now() / 3600000)}`;

  try {
    const total = await redis.incrBy(hourKey, tokens);
    if (total === tokens) {
      await redis.expire(hourKey, 3600);
    }
  } catch (err) {
    console.warn(`[ratelimit] token accounting failed: ${err.message}`);
  }
}

/** Current usage for a caller, for diagnostics and the UI. */
async function getUsage(callerId) {
  const redis = getClient();
  if (!redis) return { enforced: false };

  const id = callerId || ANON;
  try {
    // Sliding window: count only entries inside the last 60 seconds.
    await redis.zRemRangeByScore(`rl:req:${id}`, 0, Date.now() - 60000);
    const requests = await redis.zCard(`rl:req:${id}`);
    const tokens = Number(
      (await redis.get(`rl:tok:${id}:${Math.floor(Date.now() / 3600000)}`)) || 0
    );
    return {
      enforced: true,
      requests,
      requestLimit: LIMITS.requestsPerMinute,
      tokens,
      tokenLimit: LIMITS.tokensPerHour,
    };
  } catch {
    return { enforced: false };
  }
}

/** Test helper — clear a caller's counters. */
async function resetLimits(callerId) {
  const redis = getClient();
  if (!redis) return;
  const id = callerId || ANON;
  try {
    await redis.del([
      `rl:req:${id}`,
      `rl:tok:${id}:${Math.floor(Date.now() / 3600000)}`,
    ]);
  } catch {
    /* best effort */
  }
}

module.exports = { checkRateLimit, recordTokens, getUsage, resetLimits, LIMITS };
