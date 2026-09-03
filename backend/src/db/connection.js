/**
 * connection.js
 *
 * Connects to MongoDB, and — importantly — decides what happens when it
 * cannot.
 *
 * A DESIGN DECISION WORTH UNDERSTANDING:
 *
 * There are two reasonable answers when the database is unreachable at startup:
 *
 *   (a) Crash. No database, no service. Simple and unambiguous.
 *   (b) Start anyway, run without persistence, log loudly.
 *
 * We chose (b), for one specific reason: persistence here is OBSERVABILITY,
 * not correctness. The agent's safety rails — the confirmation gate, the policy
 * limits, the eligibility checks — are all pure JavaScript and do not touch the
 * database at all. A Mongo outage means we lose the trace history. It does not
 * mean we might issue a wrong refund.
 *
 * Refusing to answer customers because the analytics store is down would be
 * choosing a bigger outage than the one we actually have.
 *
 * That reasoning does NOT hold once Build 2 stores paused approvals here. At
 * that point a Mongo outage means a paused refund could be lost, and the right
 * answer flips to (a). Noted now so the decision gets revisited rather than
 * inherited.
 */

const mongoose = require("mongoose");

let connected = false;

/** Is the database currently usable? Callers use this to skip persistence. */
function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}

/**
 * Connect to MongoDB.
 *
 * @param {string} [uri]
 * @returns {Promise<boolean>} true if connected, false if running without a DB
 */
async function connectDB(uri = process.env.MONGODB_URI) {
  if (!uri) {
    console.warn(
      "[db] MONGODB_URI is not set — running WITHOUT persistence. " +
        "Traces and business data will not survive a restart."
    );
    return false;
  }

  try {
    await mongoose.connect(uri, {
      // Fail fast rather than hanging for the 30-second default. If Mongo is
      // not there, we want to know at startup, not two minutes into debugging.
      serverSelectionTimeoutMS: 5000,
    });

    connected = true;
    console.log(`[db] connected to MongoDB`);

    // A dropped connection later must not leave `connected` stale, or every
    // subsequent write throws instead of being skipped.
    mongoose.connection.on("disconnected", () => {
      connected = false;
      console.warn("[db] disconnected — persistence paused");
    });
    mongoose.connection.on("reconnected", () => {
      connected = true;
      console.log("[db] reconnected");
    });

    return true;
  } catch (err) {
    connected = false;
    console.warn(
      `[db] could not connect (${err.message}) — running WITHOUT persistence.`
    );
    return false;
  }
}

/** Close the connection cleanly on shutdown. */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    connected = false;
  }
}

module.exports = { connectDB, disconnectDB, isConnected };
