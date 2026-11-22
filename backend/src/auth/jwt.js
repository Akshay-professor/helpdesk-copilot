/**
 * Minimal HS256 JWT - sign and verify, with node:crypto and nothing else.
 *
 * Used for the voice WebSocket. The assignment: "WebSocket, JWT in the
 * Sec-WebSocket-Protocol header (not the URL - credentials in URLs land in
 * access logs)". A browser cannot set Authorization on `new WebSocket()`, but
 * it CAN set the subprotocol list, so that is where the token travels.
 *
 * Why hand-rolled instead of `jsonwebtoken`: HS256 is one HMAC and two
 * base64url calls. The dangerous parts of JWT are the ones this refuses to
 * implement - `alg: none`, algorithm switching, RS/HS confusion. Only HS256
 * is accepted, the header is checked, and the signature is compared in
 * constant time.
 * ponytail: swap for `jose` if you ever need RS256 / key rotation / JWKS.
 */

const crypto = require("node:crypto");

// No JWT_SECRET configured -> a random per-process secret. Tokens then die on
// restart, which is harmless for 60-second voice tokens and keeps a missing
// env var from silently meaning "everyone shares the secret 'changeme'".
const SECRET =
  process.env.JWT_SECRET ||
  (console.warn("[auth] JWT_SECRET not set - using a random per-process secret."),
  crypto.randomBytes(32).toString("hex"));

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function hmac(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * @param {object} claims   e.g. { sub: "cus_001" }
 * @param {number} ttlSec   lifetime in seconds
 */
function sign(claims, ttlSec = 60, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSec }));
  return `${HEADER}.${body}.${hmac(`${HEADER}.${body}`, secret)}`;
}

/**
 * @returns {object|null} the claims, or null for ANY problem (bad shape, wrong
 *          alg, bad signature, expired). The caller never learns which - an
 *          attacker should not either.
 */
function verify(token, secret = SECRET) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;

  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    if (header.alg !== "HS256") return null; // no "none", no alg switching

    const expected = Buffer.from(hmac(`${h}.${b}`, secret));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return null;
    }

    const claims = JSON.parse(Buffer.from(b, "base64url").toString());
    if (typeof claims.exp !== "number" || claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };

if (require.main === module) {
  const assert = require("node:assert");
  const t = sign({ sub: "cus_001" }, 60, "k");
  assert.equal(verify(t, "k").sub, "cus_001");
  assert.equal(verify(t, "other"), null, "wrong secret");
  assert.equal(verify(t.slice(0, -2) + "xx", "k"), null, "tampered signature");
  const [, body] = t.split(".");
  const none = `${b64url(JSON.stringify({ alg: "none" }))}.${body}.`;
  assert.equal(verify(none, "k"), null, "alg none");
  assert.equal(verify(sign({ sub: "x" }, -1, "k"), "k"), null, "expired");
  assert.equal(verify("garbage", "k"), null);
  console.log("jwt: all checks pass");
}
