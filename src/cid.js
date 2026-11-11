// "Sign in with Cumulus ID" for a server-rendered app (OAuth 2.0 code + PKCE S256).
//
//   GET  /auth/cid/start[?create=1]  -> 302 to <issuer>/api/id/authorize
//   GET  /auth/cid/callback?code&state -> POST <issuer>/api/id/token -> profile { cid, username, email }
//
// People without a Cumulus ID create one on the issuer's sign-in page (same flow) and come back
// signed in. The issuer is configurable (CID_ISSUER) so a mirror that loads in Russia can be used.
// No dependencies: node:crypto and global fetch only.
import crypto from "node:crypto";

export const DEFAULT_ISSUER = "https://id.cumuluscloud.app";
const PENDING_COOKIE = "cid_pending";
const PENDING_TTL_S = 600;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function cidConfig(env = process.env, defaults = {}) {
  const issuer = String(env.CID_ISSUER || defaults.issuer || DEFAULT_ISSUER).replace(/\/+$/, "");
  const clientId = String(env.CID_CLIENT_ID || defaults.clientId || "");
  const owners = String(env.CID_OWNERS || defaults.owners || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { issuer, clientId, owners };
}

/** The signed blob kept in a short-lived cookie between start and callback. */
function seal(secret, data) {
  const body = b64url(JSON.stringify(data));
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function unseal(secret, value) {
  const [body, mac] = String(value || "").split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return data && data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

/**
 * Starts the sign-in. Returns { location, cookie } for a 302.
 * `create` asks the issuer to open on "Create a Cumulus ID" (prompt=create, OIDC); issuers that
 * ignore it still offer Create on the same page.
 */
export function startSignIn({ issuer, clientId, redirectUri, secret, create = false, secure = true, next = "/" }) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (create) q.set("prompt", "create");
  const pending = seal(secret, { verifier, state, next: safeNext(next), exp: Math.floor(Date.now() / 1000) + PENDING_TTL_S });
  return {
    location: `${issuer}/api/id/authorize?${q}`,
    cookie: `${PENDING_COOKIE}=${pending}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PENDING_TTL_S}${secure ? "; Secure" : ""}`,
  };
}

/** Clears the pending cookie. */
export const clearPending = (secure = true) => `${PENDING_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;

/**
 * Finishes the sign-in: checks state, redeems the code at the issuer, returns { profile, next }.
 * Throws an Error with a plain-language message on any failure.
 */
export async function finishSignIn({ issuer, clientId, redirectUri, secret, query, cookies, fetchImpl = fetch }) {
  const pending = unseal(secret, cookies[PENDING_COOKIE]);
  if (!pending) throw new Error("That sign-in expired. Please sign in again.");
  const error = query.get("error") || query.get("cid_error");
  if (error) throw new Error("Cumulus ID sign-in was cancelled.");
  const code = query.get("code") || "";
  if (!code || query.get("state") !== pending.state) throw new Error("That sign-in link doesn't match. Please sign in again.");
  let res;
  try {
    res = await fetchImpl(`${issuer}/api/id/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, code_verifier: pending.verifier, client_id: clientId, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("Cumulus ID could not be reached. Please try again.");
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.profile || !out.profile.cid) throw new Error(out.error || "Cumulus ID did not accept that sign-in.");
  return { profile: out.profile, next: pending.next };
}

/** True when the profile is allowed in. An empty owner list lets nobody in. */
export function isOwner(profile, owners) {
  if (!profile) return false;
  const ids = [profile.cid, profile.username, profile.handle, profile.email].filter(Boolean).map((s) => String(s).toLowerCase());
  return owners.some((o) => ids.includes(o));
}

function safeNext(next) {
  const s = String(next || "/");
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") ? s : "/";
}
