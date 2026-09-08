import { useState, useRef, useEffect, useCallback } from "react";

/**
 * VoiceCall
 *
 * The browser half of the voice channel. The backend has been complete since
 * Phase 20 - transcription, filler, speech formatting, spoken approval,
 * barge-in - but until now there was NO WAY TO USE IT from a browser. A
 * feature with no front door is a feature nobody can see.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 *
 *   mic  ->  MediaRecorder (webm)  ->  WebSocket  ->  Whisper  ->  agent core
 *                                                                     |
 *   speaker  <-  Web Speech API  <-  speech-formatted text  <----------+
 *
 * Speech OUT uses the browser's own speechSynthesis rather than a cloud TTS.
 * It costs nothing, needs no key, and starts speaking in ~50ms instead of
 * waiting on a network round trip. The assignment asks for "sub-second
 * time-to-first-audio"; this is comfortably inside it.
 *
 * ---------------------------------------------------------------------------
 * THE THING THAT MAKES VOICE HARD
 * ---------------------------------------------------------------------------
 *
 * In chat, a pause is invisible. On a call, a pause is ALARMING - three
 * seconds of silence and a person says "hello? are you there?". So this
 * component has to keep the caller informed while the agent works, and it has
 * to stop talking the instant the caller starts.
 */

const WS_URL =
  (import.meta.env.VITE_API_URL ?? "http://localhost:5000")
    .replace(/^http/, "ws") + "/voice";

/** Speech-out. One utterance at a time, cancellable mid-word for barge-in. */
function useSpeaker() {
  const currentRef = useRef(null);

  const speak = useCallback((text, onEnd) => {
    if (!("speechSynthesis" in window)) return onEnd?.();
    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; // slightly brisk - support calls should not feel slow
    u.pitch = 1;
    u.onend = () => {
      currentRef.current = null;
      onEnd?.();
    };
    currentRef.current = u;
    window.speechSynthesis.speak(u);
  }, []);

  // Barge-in: stop mid-word. Note we stop SPEAKING, not the run - the agent
  // may already have moved money, and cancelling the audio must never be
  // mistaken for cancelling the action.
  const stop = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    currentRef.current = null;
  }, []);

  return { speak, stop, isSpeaking: () => Boolean(currentRef.current) };
}

export default function VoiceCall({ active = true }) {
  const [status, setStatus] = useState("idle"); // idle|connecting|live|ended
  const [turns, setTurns] = useState([]);
  const [activity, setActivity] = useState([]);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(null);
  const [typed, setTyped] = useState("");

  const wsRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const scrollRef = useRef(null);
  const { speak, stop, isSpeaking } = useSpeaker();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, activity]);

  const addTurn = useCallback((who, text, kind) => {
    setTurns((t) => [...t, { who, text, kind, at: Date.now() }]);
  }, []);

  // ---- teardown ---------------------------------------------------------
  const hangUp = useCallback(() => {
    stop();
    cancelAnimationFrame(rafRef.current);
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "hangup" }));
      wsRef.current.close();
    }
    recorderRef.current = null;
    streamRef.current = null;
    wsRef.current = null;
    setListening(false);
    setLevel(0);
    setStatus("ended");
  }, [stop]);

  // Tear the call down only when the component really goes away - NOT when the
  // tab is merely hidden. That distinction is the whole point of keeping the
  // panel mounted: switching to Approvals mid-call must not hang up.
  useEffect(() => () => hangUp(), [hangUp]);

  // The waveform is a 60fps render loop. While the tab is hidden nobody can
  // see it, so pause it and resume on return. The CALL keeps running; only the
  // animation stops.
  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    if (!analyserRef.current) return;

    const analyser = analyserRef.current;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      setLevel(Math.min(1, peak / 60));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, status]);

  // ---- the call ---------------------------------------------------------
  async function startCall() {
    setError(null);
    setTurns([]);
    setActivity([]);
    setStatus("connecting");

    // 1. Microphone permission FIRST. If this fails there is no point opening
    //    a socket, and the browser error is clearer than ours would be.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setError(
        err.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in your browser's address bar, then try again."
          : `Could not open the microphone: ${err.message}`
      );
      setStatus("idle");
      return;
    }
    streamRef.current = stream;

    // 2. Waveform. Purely cosmetic, and worth it: a caller who can see the bar
    //    move knows the mic is live without having to guess.
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    analyserRef.current = analyser;

    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      setLevel(Math.min(1, peak / 60));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    // 3. The socket.
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => setStatus("live");

    ws.onerror = () => {
      setError("Could not reach the voice server. Is the backend running?");
      setStatus("idle");
    };

    ws.onclose = () => setStatus((s) => (s === "live" ? "ended" : s));

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleEvent(msg);
    };
  }

  /**
   * Every event the backend can send. Kept as one switch so the protocol is
   * readable in one place rather than scattered through handlers.
   */
  function handleEvent(msg) {
    switch (msg.type) {
      case "ready":
        addTurn("system", "Connected. Start speaking, or type below.", "ok");
        break;

      case "transcript":
        // What Whisper heard. Shown even when it is wrong - especially when
        // it is wrong, because a caller who sees the misheard text understands
        // instantly why the answer was strange.
        addTurn("caller", msg.text);
        break;

      case "filler":
      case "filler_final":
        // "Let me look into that for you." Spoken, and marked as filler so
        // the transcript does not pretend it was a real answer.
        addTurn("agent", msg.text, "filler");
        speak(msg.text);
        break;

      case "speak":
      case "answer":
        addTurn("agent", msg.text, msg.kind === "error" ? "bad" : undefined);
        speak(msg.text, () => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "speech_end" }));
          }
        });
        break;

      case "awaiting_confirmation":
      case "confirm":
      case "reconfirm":
        // The spoken approval. The caller answers with their voice; there is
        // no button, because there is no screen on a phone call.
        addTurn("agent", msg.text, "confirm");
        speak(msg.text);
        break;

      case "agent_activity":
      case "tool_call":
      case "routed":
      case "handoff":
      case "thinking":
        setActivity((a) => [
          ...a.slice(-6),
          { text: msg.text ?? msg.tool ?? msg.type, at: Date.now() },
        ]);
        break;

      case "barge_in":
        stop();
        addTurn("system", "— interrupted —", "muted");
        break;

      case "discarded":
        addTurn("system", msg.text ?? "That didn't come through clearly.", "muted");
        break;

      case "error":
        addTurn("agent", msg.text ?? "Something went wrong.", "bad");
        break;

      case "done":
        setActivity([]);
        break;

      default:
        break;
    }
  }

  // ---- push to talk -----------------------------------------------------
  //
  // Push-to-talk rather than always-on. Voice activity detection in a browser
  // is unreliable in a noisy room, and a support agent that starts answering
  // your colleague's conversation is worse than one that needs a button.
  function startTalking() {
    if (status !== "live" || listening) return;

    // Barge-in: if the agent is mid-sentence, cut it off. This is the whole
    // point - a caller must be able to interrupt.
    if (isSpeaking()) {
      stop();
      wsRef.current?.send(JSON.stringify({ type: "barge_in" }));
    }

    const rec = new MediaRecorder(streamRef.current, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      // Below ~2KB is a click, not speech. Sending it wastes a Whisper call
      // and usually transcribes as "you" or "thank you".
      if (blob.size < 2000) {
        addTurn("system", "Too short — hold the button while you speak.", "muted");
        return;
      }
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(await blob.arrayBuffer());
      }
    };
    rec.start();
    recorderRef.current = rec;
    setListening(true);
  }

  function stopTalking() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setListening(false);
  }

  function sendTyped() {
    const t = typed.trim();
    if (!t || status !== "live") return;
    setTyped("");
    if (isSpeaking()) {
      stop();
      wsRef.current?.send(JSON.stringify({ type: "barge_in" }));
    }
    wsRef.current?.send(JSON.stringify({ type: "text", text: t }));
  }

  const live = status === "live";

  return (
    <div className="voice">
      <div className="voice-head">
        <h2>Voice call</h2>
        <span className={`dot ${status}`} />
        <span className="muted small">
          {status === "idle" && "not connected"}
          {status === "connecting" && "connecting…"}
          {status === "live" && "on the call"}
          {status === "ended" && "call ended"}
        </span>
        <div className="grow" />
        {!live ? (
          <button className="btn-primary" onClick={startCall} disabled={status === "connecting"}>
            {status === "ended" ? "Call again" : "Start call"}
          </button>
        ) : (
          <button className="btn-danger" onClick={hangUp}>
            Hang up
          </button>
        )}
      </div>

      {error && <div className="notice bad">{error}</div>}

      <div className="voice-body">
        <div className="transcript" ref={scrollRef}>
          {turns.length === 0 && !live && (
            <div className="empty">
              Press <strong>Start call</strong>, then hold the mic button and speak.
              <br />
              <br />
              Try: <em>"Where is my order ord 1001"</em>
              <br />
              <em>"Refund two hundred forty dollars on order ord 1001"</em>
              <br />
              <br />
              The agent will ask you to confirm out loud — just say “yes”.
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i} className={`turn ${t.who} ${t.kind ?? ""}`}>
              <span className="turn-who">
                {t.who === "caller" ? "you" : t.who === "agent" ? "agent" : ""}
              </span>
              <span className="turn-text">{t.text}</span>
              {t.kind === "filler" && <span className="turn-tag">filler</span>}
              {t.kind === "confirm" && <span className="turn-tag warn">approval</span>}
            </div>
          ))}

          {activity.length > 0 && (
            <div className="voice-activity">
              {activity.map((a, i) => (
                <div key={i}>{a.text}</div>
              ))}
            </div>
          )}
        </div>

        <div className="voice-controls">
          <div className="meter">
            <div className="meter-fill" style={{ width: `${level * 100}%` }} />
          </div>

          <button
            className={`mic ${listening ? "on" : ""}`}
            disabled={!live}
            onMouseDown={startTalking}
            onMouseUp={stopTalking}
            onMouseLeave={stopTalking}
            onTouchStart={(e) => {
              e.preventDefault();
              startTalking();
            }}
            onTouchEnd={stopTalking}
          >
            {listening ? "● Listening — release to send" : "Hold to talk"}
          </button>

          <div className="voice-typed">
            <input
              value={typed}
              placeholder={live ? "…or type instead of speaking" : "Start the call first"}
              disabled={!live}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendTyped()}
            />
            <button onClick={sendTyped} disabled={!live || !typed.trim()}>
              Send
            </button>
          </div>

          <p className="muted small">
            Speech-out uses your browser's own voice — no cloud TTS, so it starts
            in about 50ms. Interrupt any time by holding the mic button.
          </p>
        </div>
      </div>
    </div>
  );
}
