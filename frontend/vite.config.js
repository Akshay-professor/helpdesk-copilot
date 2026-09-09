import { defineConfig, createLogger } from "vite";
import react from "@vitejs/plugin-react";

/** Shared between the logger and the proxy's recovery message. */
let backendDown = false;

/**
 * Vite's logger, with one behaviour changed: a repeated "backend is down"
 * becomes a single helpful line instead of a stack trace per request.
 *
 * Everything else passes through untouched - a build error still looks
 * exactly like a build error. Quieting a specific known-noisy case is very
 * different from turning the volume down on everything, and only the first
 * one is safe.
 */
function makeQuietLogger() {
  const base = createLogger();
  return {
    ...base,
    error(msg, opts) {
      const text = String(msg);
      if (text.includes("http proxy error") && text.includes("ECONNREFUSED")) {
        if (!backendDown) {
          backendDown = true;
          base.info(
            "\n  Backend not running on :5000 — the UI will keep retrying.\n" +
              "  Start it in another terminal:  cd backend && npm run dev\n"
          );
        }
        return;
      }
      base.error(msg, opts);
    },
  };
}

/**
 * Vite config.
 *
 * THE PROXY IS THE IMPORTANT PART.
 *
 * The dev server runs on :5173, the API on :5000. A browser refuses to let a
 * page on one origin call another (CORS), so without help every fetch would
 * fail before it left the browser.
 *
 * Two ways to fix that:
 *   1. Add CORS headers to Express, telling browsers :5173 is allowed
 *   2. Proxy - the dev server forwards /api/* to :5000 itself
 *
 * We use the proxy. The browser only ever talks to :5173, so as far as it is
 * concerned there is one origin and no CORS rule applies. It also means the
 * frontend code says `fetch("/api/chat")` with no hostname anywhere, which is
 * exactly what you want in production too - where both are usually served from
 * one domain and no proxy is needed at all.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
        // Strip the /api prefix: /api/chat -> /chat
        rewrite: (path) => path.replace(/^\/api/, ""),

        // Note the recovery message lives in the logger below, not here.
        // Vite attaches its OWN error handler after calling `configure`, so a
        // handler added here runs in addition to Vite's - it cannot suppress
        // the stack trace. The logger is the only place that can.
        configure: (proxy) => {
          proxy.on("proxyRes", () => {
            if (backendDown) {
              backendDown = false;
              console.log("\n  Backend is back.\n");
            }
          });
        },
      },
    },
  },

  // ---- ONE LINE PER OUTAGE, NOT ONE PER REQUEST ---------------------------
  //
  // The app polls /approvals, /routing and /costs every 10-15 seconds. With
  // the backend down, Vite prints a full stack trace for every one - hundreds
  // of identical traces scrolling past, all saying the same thing, and none
  // of them mentioning the only fact that matters:
  //
  //     the backend is not running.
  //
  // The trace is worthless here. It points at node:net, which is not where
  // the fault is, and the fault is not in code at all.
  //
  // So: say it once, say what to do, and stay quiet until the state changes.
  // A log that repeats itself is a log people stop reading - and then they
  // miss the one line in it that was worth reading.
  customLogger: makeQuietLogger(),
});
