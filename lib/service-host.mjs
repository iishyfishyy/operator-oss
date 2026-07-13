/* Public service hostnames — pure helpers (no state, no DB).
 *
 * A running service is published at  <slug>--<appHost>  where appHost is the
 * host of PUBLIC_BASE_URL (e.g. calc--ishan.getoperator.dev for the instance at
 * https://ishan.getoperator.dev). The scheme is FLAT on purpose: Cloudflare
 * Universal SSL only covers *.getoperator.dev one level deep, so a nested
 * calc.ishan.getoperator.dev would need paid Advanced Certificate Manager.
 * "--" is the separator, which is why service slugs may never contain it.
 *
 * Plain ESM JS (like lib/auth/origin.mjs) because it's imported from three
 * worlds: server.js (raw Node, pre-Next), Next route handlers, and vitest.
 */
import crypto from "node:crypto";

/** Host (no port) of PUBLIC_BASE_URL, or null when unset/unparsable (local dev). */
export function appHostFromEnv(env = process.env) {
  const base = (env.PUBLIC_BASE_URL || "").trim();
  if (!base) return null;
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Classify an incoming Host header against this instance's own hostname.
 *   { type: "app" }                    — the app's own hostname: pass to Next untouched
 *   { type: "service", name }          — <name>--<appHost>: dispatch to the service router
 *   { type: "invalid", name }          — --host shape but the name is not a legal slug
 *   { type: "other" }                  — anything else (localhost, probes): pass to Next
 */
export function parseServiceHost(hostHeader, appHost) {
  const host = String(hostHeader || "").toLowerCase().replace(/:\d+$/, "");
  if (!appHost || !host) return { type: "other" };
  if (host === appHost) return { type: "app" };
  const marker = `--${appHost}`;
  if (!host.endsWith(marker)) return { type: "other" };
  const name = host.slice(0, -marker.length);
  // A name containing "--" (e.g. a--b--ishan.…) parses ambiguously — rejected
  // here and never issued at registration (slugifyServiceName collapses runs).
  return isValidServiceSlug(name) ? { type: "service", name } : { type: "invalid", name };
}

/** Legal public slug: lowercase [a-z0-9-], starts/ends alphanumeric, no "--". */
export function isValidServiceSlug(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 63 && // single DNS label
    !s.includes("--") &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)
  );
}

/** Best-effort slug from a free-form name; "" when nothing usable survives. */
export function slugifyServiceName(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any junk run -> single hyphen (also kills "--")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// ---------- gate tokens ----------
// The short-lived credential a browser holds for a private/shared service, both
// as the ?t= handoff from /api/services/grant and as the orch_svc cookie on the
// service hostname. HMAC over (slug, expiry) with an instance-local secret —
// minted and verified on the same box, so no PKI needed.

export const GATE_COOKIE = "orch_svc";

export function mintGateToken(secret, slug, ttlMs, now = Date.now()) {
  const exp = now + ttlMs;
  const sig = gateSig(secret, slug, exp);
  return `${exp}.${sig}`;
}

export function verifyGateToken(secret, token, slug, now = Date.now()) {
  if (!secret || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < now) return false;
  const expected = gateSig(secret, slug, exp);
  const given = token.slice(dot + 1);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function gateSig(secret, slug, exp) {
  return crypto.createHmac("sha256", String(secret)).update(`${slug}\n${exp}`).digest("base64url");
}

/** Parse a Cookie header into a name->value map (dupes: first wins). */
export function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[k] = part.slice(i + 1).trim();
      }
    }
  }
  return out;
}
