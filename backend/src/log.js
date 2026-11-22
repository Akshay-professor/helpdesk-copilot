/**
 * Structured run log: one JSON line per LLM call, tool execution and run end,
 * each carrying the run's correlation ID.
 *
 * The assignment: "one request may involve 8 LLM calls and 15 tool
 * executions; that must be reconstructable from logs." With this,
 *
 *     node src/server.js | grep '"runId":"<id>"'
 *
 * replays a run in order without touching the database. JSON lines rather
 * than prose so any log shipper (Loki, CloudWatch, Datadog) can index fields.
 * ponytail: stdout only; swap for pino if log volume ever matters.
 */
function logEvent(event, fields = {}) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  } catch {
    // A log line must never take down a run.
  }
}

module.exports = { logEvent };
