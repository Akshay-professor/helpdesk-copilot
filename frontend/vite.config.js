import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
      },
    },
  },
});
