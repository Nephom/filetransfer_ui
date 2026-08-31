// Pure helpers for reasoning about the lifetime of the JWT the backend
// hands back from POST /auth/login (see src/backend/auth/auth.js and
// src/backend/server.js, both of which sign with `{ expiresIn: '24h' }`).
// No React state, no side effects -- matches the "*-contracts.ts" file
// kind documented on the main.tsx refactor (see GitHub issue #228's
// "Design pattern used in every phase" section).

// Decodes a JWT's payload segment and returns its `exp` claim (seconds
// since epoch, per the JWT spec) converted to a millisecond timestamp
// this app's own clock can compare against directly. Returns null for any
// token that is empty, malformed, not a JWT, or missing an `exp` claim --
// callers must treat null as "unknown expiry", not as "already expired",
// since the token itself may still be perfectly valid (the backend is the
// only real authority on that).
export const decodeJwtExpiryMs = (token: string): number | null => {
  if (!token) return null;
  const segments = token.split(".");
  if (segments.length < 2) return null;
  try {
    // JWTs use base64url, not base64: swap the two characters that differ
    // before handing the string to atob, and drop the padding atob doesn't
    // want.
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split("")
        .map((char) => "%" + char.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
};

// How long before the real expiry this app should proactively refresh the
// token, so a refresh attempt (network round trip + retry) has room to
// finish before the old token actually stops working.
export const tokenRefreshLeadMs = 5 * 60 * 1000;

// Clamps the delay used to schedule the next refresh attempt: never
// negative (an already-expired/near-expired token refreshes immediately),
// and never longer than a sane ceiling, so a token with a very long
// lifetime (or a clock skew edge case) doesn't schedule a multi-day
// `setTimeout` that a browser/webview may silently drop.
export const clampRefreshDelayMs = (delayMs: number, maxMs = 24 * 60 * 60 * 1000) =>
  Math.max(0, Math.min(delayMs, maxMs));
