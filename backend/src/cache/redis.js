/**
 * redis.js
 *
 * Connects to Redis. Same pattern as MongoDB and ChromaDB: one file owns the
 * connection, everything else calls plain functions.
 *
 * ---------------------------------------------------------------------------
 * WHEN REDIS IS DOWN — AND WHY THIS ONE IS DIFFERENT
 * ---------------------------------------------------------------------------
 *
 * MongoDB and ChromaDB both fail OPEN here: lose the database, lose the trace,
 * keep serving customers. That was defensible because neither is load-bearing
 * for correctness.
 *
 * Redis holds the rate limiter, and a rate limiter that fails open is not a
 * rate limiter — the moment it matters most (something is hammering the
 * service) is exactly when it stops working.
 *
 * But failing CLOSED means a Redis blip takes down the whole product for
 * everyone, which is a bigger outage than the one you are preventing.
 *
 * WE FAIL OPEN, LOUDLY. The reasoning:
 *   - the threat is cost, not security or data loss
 *   - per-REQUEST caps (8 iterations, 30k tokens) still hold, because they live
 *     in the loop and never touch Redis — so a single request still cannot run
 *     away
 *   - what is lost is only the per-USER ceiling, and only while Redis is down
 *
 * That is a real trade with a stated reason, not a default. A system where
 * exceeding the limit meant a security breach rather than a bill should make
 * the opposite call.
 */

const { createClient } = require("redis");

let client = null;
let connected = false;

/** Is Redis usable right now? */
function isReady() {
  return connected && client?.isOpen;
}

/**
 * Connect to Redis.
 *
 * @returns {Promise<boolean>} false if unavailable — never throws
 */
async function connectRedis(url = process.env.REDIS_URL) {
  const target = url || "redis://localhost:6379";

  try {
    client = createClient({
      url: target,
      socket: {
        connectTimeout: 3000,
        // Give up reconnecting after a few tries rather than retrying forever
        // in the background. A permanently-retrying client fills logs and
        // hides the fact that Redis is simply not there.
        reconnectStrategy: (attempts) =>
          attempts > 5 ? false : Math.min(attempts * 200, 2000),
      },
    });

    // The client emits errors asynchronously. Without a listener, Node treats
    // an unhandled 'error' event as fatal and kills the process — so a Redis
    // blip would crash the whole server. This listener is not optional.
    client.on("error", (err) => {
      if (connected) {
        console.warn(`[redis] connection error: ${err.message}`);
        connected = false;
      }
    });
    client.on("ready", () => {
      connected = true;
    });
    client.on("end", () => {
      connected = false;
    });

    await client.connect();
    connected = true;
    console.log("[redis] connected");
    return true;
  } catch (err) {
    connected = false;
    console.warn(
      `[redis] unavailable (${err.message}) — per-user rate limiting is OFF. ` +
        `Per-request caps (iterations, tokens) still apply.`
    );
    return false;
  }
}

async function disconnectRedis() {
  if (client?.isOpen) {
    await client.quit();
  }
  connected = false;
}

/** The raw client, for the limiter. Null when unavailable. */
function getClient() {
  return isReady() ? client : null;
}

module.exports = { connectRedis, disconnectRedis, isReady, getClient };
