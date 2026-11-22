/**
 * voiceServer.js
 *
 * The WebSocket endpoint for voice calls.
 *
 * ---------------------------------------------------------------------------
 * WHY A WEBSOCKET AND NOT HTTP
 * ---------------------------------------------------------------------------
 *
 * The assignment specifies it, and the reason is worth stating.
 *
 * Chat is REQUEST/RESPONSE: you send, you wait, you get an answer. HTTP fits
 * perfectly.
 *
 * A call is not like that. Audio flows up while filler flows down; the caller
 * can interrupt at any moment; the server needs to push "still working on
 * this" without being asked. That is a CONVERSATION between two peers, and a
 * WebSocket is the protocol shaped like one.
 *
 * THE ANALOGY. HTTP is letters - one goes out, one comes back, each complete
 * in itself. A WebSocket is a phone line: open, two-way, and either side may
 * speak first. You cannot barge in on a letter.
 *
 * ---------------------------------------------------------------------------
 * THE JWT GOES IN THE HEADER, NOT THE URL
 * ---------------------------------------------------------------------------
 *
 * > "Voice: WebSocket, JWT in the Sec-WebSocket-Protocol header (not the URL -
 * >  credentials in URLs land in access logs)"
 *
 * This is a small requirement with a large lesson.
 *
 *     ws://api/voice?token=eyJhbGciOi...             <- WRONG
 *     Sec-WebSocket-Protocol: helpdesk.v1, eyJhbG... <- RIGHT (browser)
 *     Authorization: Bearer eyJhbGciOi...            <- RIGHT (server-side)
 *
 * A URL is not a secret channel. It is written to the server's access log,
 * every proxy and load balancer in between, the browser's history, and the
 * Referer header of anything the page links to. A token in a query string is a
 * token you have published - and unlike a password, nobody ever rotates it,
 * because it does not FEEL leaked.
 *
 * A header is not encrypted either, but it is not ROUTINELY WRITTEN DOWN, and
 * that is the whole difference.
 *
 * > The same secret can be safe in one place and public in another. Where a
 * > value travels matters as much as what it is.
 *
 * ---------------------------------------------------------------------------
 * WIRE PROTOCOL
 * ---------------------------------------------------------------------------
 *
 * Client -> server
 *   binary frame         a chunk of recorded audio
 *   {type:"text"}        typed input (testing, and accessibility)
 *   {type:"barge_in"}    the caller started talking
 *   {type:"speech_end"}  playback finished
 *
 * Server -> client
 *   {type:"transcript"}  what we heard
 *   {type:"speak"}       text for the browser to say aloud
 *   {type:"agent_activity"} tool calls, for the live transcript view
 *   {type:"barge_in"}    interruption acknowledged
 *   {type:"discarded"}   a reply was thrown away, and why
 */

const { WebSocketServer } = require("ws");
const { VoiceSession } = require("./voiceSession");
const { isConfigured } = require("./stt");
const { verify } = require("../auth/jwt");

/**
 * Read the caller's identity from the HANDSHAKE HEADERS - never the URL.
 *
 * A browser cannot set Authorization on `new WebSocket()`, but it CAN set the
 * subprotocol list, which arrives as the Sec-WebSocket-Protocol header. So the
 * page calls `new WebSocket(url, ["helpdesk.v1", token])`, where `token` is a
 * 60-second JWT from POST /voice/token. The server answers with
 * "helpdesk.v1" only - echoing the token back would put it in a response
 * header for no reason.
 *
 * Authorization: Bearer <jwt> is accepted too, for server-side clients (tests).
 * Both carry a signed JWT; the old raw-caller-id bearer is gone.
 *
 * @returns {{callerId, via}} or {error} for a credential that is PRESENT but
 *          invalid. A bad token is rejected outright - silently downgrading it
 *          to anonymous would hide an attack or a bug.
 */
const SUBPROTOCOL = "helpdesk.v1";

function identify(req) {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const fromProtocol = offered.find((p) => p !== SUBPROTOCOL);

  const auth = req.headers["authorization"];
  const fromHeader = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;

  const token = fromProtocol ?? fromHeader;
  if (!token) return { callerId: null, via: "anonymous" };

  const claims = verify(token);
  if (!claims) return { error: "invalid_token" };
  return {
    callerId: claims.sub ?? null,
    via: fromProtocol ? "sec-websocket-protocol" : "authorization-header",
  };
}

/**
 * Attach the voice endpoint to an existing HTTP server.
 *
 * Sharing the server rather than opening a second port means one TLS
 * certificate, one firewall rule, and one origin - so the browser's
 * same-origin rules work in our favour instead of needing to be worked around.
 */
function attachVoiceServer(httpServer, { path = "/voice" } = {}) {
  const wss = new WebSocketServer({
    server: httpServer,
    path,
    // Reject a bad token during the HANDSHAKE, before a session exists.
    verifyClient: ({ req }, done) =>
      identify(req).error ? done(false, 401, "Invalid or expired token") : done(true),
    // Select our protocol name, never the token.
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  wss.on("connection", (ws, req) => {
    const { callerId, via } = identify(req);

    const session = new VoiceSession({
      callerId,
      onEvent: (event) => {
        // A socket can close between the agent starting work and finishing it.
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      },
    });

    console.log(`[voice] connected ${session.sessionId} caller=${callerId ?? "anon"} (${via})`);

    ws.send(
      JSON.stringify({
        type: "ready",
        sessionId: session.sessionId,
        callerId,
        auth: via,
        sttAvailable: isConfigured(),
        greeting:
          "Hi, you're through to HelpDesk. How can I help with your order today?",
      })
    );

    // Guard against overlapping turns. Without this, a caller who speaks twice
    // quickly starts two agent runs against the same history and gets two
    // replies talking over each other.
    let busy = false;

    ws.on("message", async (data, isBinary) => {
      try {
        // ---- AUDIO ------------------------------------------------------
        if (isBinary) {
          if (busy) return; // already working; the caller will be answered
          busy = true;
          try {
            await session.handleTurn(Buffer.from(data), { mimeType: "audio/webm" });
          } finally {
            busy = false;
          }
          return;
        }

        // ---- CONTROL ----------------------------------------------------
        const msg = JSON.parse(data.toString());

        if (msg.type === "barge_in") {
          // Handled FIRST and never gated by `busy` - an interruption that
          // has to wait for the thing it is interrupting is not an
          // interruption.
          session.bargeIn();
          return;
        }

        if (msg.type === "speech_end") {
          session.finishedSpeaking();
          return;
        }

        if (msg.type === "text") {
          if (busy) return;
          busy = true;
          try {
            await session.handleTurn(String(msg.text ?? ""));
          } finally {
            busy = false;
          }
          return;
        }

        if (msg.type === "hangup") {
          ws.close(1000, "caller hung up");
          return;
        }
      } catch (err) {
        console.error("[voice] message failed:", err.message);
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: "speak",
              kind: "error",
              text: "Sorry, something went wrong. Could you say that again?",
            })
          );
        }
      }
    });

    ws.on("close", () => {
      const s = session.summary();
      console.log(
        `[voice] ended ${s.sessionId} — ${s.turns} turns, ${Math.round(s.durationMs / 1000)}s`
      );
    });

    ws.on("error", (err) => console.error("[voice] socket error:", err.message));
  });

  // Logged only once the HTTP server is actually listening.
  //
  // This used to print immediately, so a failed start looked like this:
  //
  //     [voice] websocket listening on /voice
  //     Server running on port 5000
  //     Error: listen EADDRINUSE
  //
  // Two lines claiming success directly above the failure. A startup log that
  // announces things before they are true makes every failure harder to read
  // than it needs to be.
  if (httpServer.listening) {
    console.log(`[voice] websocket listening on ${path}`);
  } else {
    httpServer.once("listening", () =>
      console.log(`[voice] websocket listening on ${path}`)
    );
  }
  return wss;
}

module.exports = { attachVoiceServer, identify };
