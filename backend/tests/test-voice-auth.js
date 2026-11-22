/**
 * Voice WebSocket auth: a JWT in Sec-WebSocket-Protocol, never the URL.
 * Offline - starts the voice server on a random port, no LLM needed.
 *
 *   node tests/test-voice-auth.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const assert = require("node:assert");
const http = require("node:http");
const WebSocket = require("ws");
const { attachVoiceServer } = require("../src/voice/voiceServer");
const { sign } = require("../src/auth/jwt");

const server = http.createServer();
attachVoiceServer(server);

server.listen(0, async () => {
  const url = `ws://localhost:${server.address().port}/voice`;
  const connect = (protocols, opts) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, protocols, opts);
      ws.on("message", (m) => {
        const msg = JSON.parse(m);
        if (msg.type === "ready") {
          resolve({ ok: true, callerId: msg.callerId, via: msg.auth, protocol: ws.protocol });
          ws.close();
        }
      });
      ws.on("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.on("error", (e) => resolve({ ok: false, error: e.message }));
    });

  const good = await connect(["helpdesk.v1", sign({ sub: "cus_001" })]);
  assert.equal(good.callerId, "cus_001");
  assert.equal(good.via, "sec-websocket-protocol");
  assert.equal(good.protocol, "helpdesk.v1", "server selects our protocol, never echoes the token");

  assert.equal((await connect(["helpdesk.v1", "a.b.c"])).status, 401, "forged token");
  assert.equal((await connect(["helpdesk.v1", sign({ sub: "x" }, -5)])).status, 401, "expired token");
  assert.equal((await connect([], { headers: { Authorization: "Bearer cus_001" } })).status, 401, "raw id is not a token");

  const anon = await connect([]);
  assert.equal(anon.callerId, null, "no credential = anonymous, not someone");

  console.log("voice auth: all checks pass");
  process.exit(0);
});
