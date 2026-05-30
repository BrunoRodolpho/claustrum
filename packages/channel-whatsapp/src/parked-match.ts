/**
 * Match an inbound user reply to a parked envelope, resolving long-lived
 * confirmation/deferral state.
 *
 * Long-lived sessions: a WhatsApp user can take 3+ days to reply to a
 * REQUEST_CONFIRMATION. When their reply arrives, the channel adapter
 * inspects the session's parked envelopes and decides whether this reply
 * is a resumption signal or a fresh utterance. If it's a resumption, the
 * conductor re-adjudicates the parked envelope with
 * `supersedes: { intentHash, reason: "confirmation_resolved" }`.
 *
 * Four match modes (in order of priority):
 *  1. **Hash-prefix probe** — `#a4b8` matches the parked envelope whose
 *     `intentHash` starts with that prefix. Highest priority because the
 *     user is being explicit; survives ambiguity when multiple envelopes
 *     are parked.
 *  2. **Defer-at phrase** — "tomorrow", "tonight", "in 2 hours", etc.
 *     Returns `defer` against the most-recently-parked envelope. The
 *     conductor maps the natural-language phrase to a concrete deferUntil.
 *  3. **Affirmative** — "yes", "sim", "ok" → confirm most-recently-parked.
 *  4. **Negative** — "no", "não", "cancel" → deny most-recently-parked.
 *
 * If none match, returns `null`: the inbound is a fresh utterance and the
 * cognitive loop runs as normal.
 */

import type { ParkedEnvelope, Session } from "@claustrum/core";
import type { ParkedMatch } from "./types.js";

// Case-insensitive matchers. Wrapped in word boundaries to avoid matching
// inside larger words (e.g. "yeshiva" must not trigger AFFIRMATIVE).
const AFFIRMATIVE_RE =
  /\b(yes|yep|sim|sí|si|ok|okay|confirm|confirmar)\b/i;
const NEGATIVE_RE = /\b(no|nope|não|nao|cancel|stop)\b/i;
const DEFER_AT_RE =
  /(tomorrow|tonight|later|amanhã|amanha|às|at\s+\d|in\s+\d+\s+(hours?|minutes?|days?))/i;
const HASH_PREFIX_RE = /#([a-f0-9]{6,12})/i;

export function matchToParkedByReply(
  inbound: string,
  session: Session,
): ParkedMatch | null {
  if (typeof inbound !== "string" || inbound.length === 0) return null;
  const parked = session.pendingConfirmations;
  if (!parked || parked.length === 0) return null;

  // 1. Hash-prefix probe — most explicit.
  const hashMatch = inbound.match(HASH_PREFIX_RE);
  if (hashMatch) {
    const prefix = hashMatch[1].toLowerCase();
    const hit = parked.find((p) =>
      p.envelope.intentHash.toLowerCase().startsWith(prefix),
    );
    if (hit) {
      return {
        parked: hit,
        userResolution: inferResolutionFromText(inbound),
      };
    }
    // If a hash prefix was supplied but doesn't match anything parked,
    // do NOT silently fall through — the user was being explicit and a
    // miss should produce a fresh utterance (returns null below).
    return null;
  }

  const mostRecent = pickMostRecentlyParked(parked);
  if (!mostRecent) return null;

  // 2. Defer phrase before affirmative — "yes, tomorrow" is a defer, not
  //    an immediate confirm.
  const deferMatch = inbound.match(DEFER_AT_RE);
  if (deferMatch) {
    return {
      parked: mostRecent,
      userResolution: "defer",
      deferPhrase: deferMatch[0],
    };
  }

  if (AFFIRMATIVE_RE.test(inbound)) {
    return {
      parked: mostRecent,
      userResolution: "confirm",
    };
  }

  if (NEGATIVE_RE.test(inbound)) {
    return {
      parked: mostRecent,
      userResolution: "deny",
    };
  }

  return null;
}

/**
 * Return the most-recently-parked envelope.
 *
 * NaN-sticky bug guard: `Date.parse` returns NaN for malformed timestamps.
 * NaN comparisons are always false (`NaN > x === false`, `NaN < x === false`),
 * so a malformed parkedAt causes the comparison to be a no-op — the loop
 * effectively never advances `best` when the current winner has a bad
 * timestamp, and a malformed entry that happens to be first will hold
 * `best` forever regardless of other entries' timestamps.
 *
 * Fix: skip any entry whose timestamp is non-finite (NaN or ±Infinity)
 * and use only entries with valid timestamps for ordering. If NO entry has
 * a parseable timestamp, fall back to the last element so there is always
 * a result rather than returning null on a non-empty list.
 */
function pickMostRecentlyParked(
  parked: ReadonlyArray<ParkedEnvelope>,
): ParkedEnvelope | null {
  if (parked.length === 0) return null;

  let best: ParkedEnvelope | undefined;
  let bestTs = -Infinity;
  const fallback: ParkedEnvelope = parked[parked.length - 1]!;

  for (const entry of parked) {
    const ts = Date.parse(entry.parkedAt);
    if (!Number.isFinite(ts)) {
      // Malformed timestamp — skip this entry for ordering purposes so it
      // cannot win or block selection (NaN-sticky-bug fix).
      continue;
    }
    if (ts >= bestTs) {
      bestTs = ts;
      best = entry;
    }
  }

  return best ?? fallback;
}

function inferResolutionFromText(text: string): "confirm" | "deny" | "defer" {
  if (DEFER_AT_RE.test(text)) return "defer";
  if (NEGATIVE_RE.test(text)) return "deny";
  // Default to confirm when the user supplied a hash prefix — addressing
  // a parked envelope by hash without an explicit negative is a positive
  // act of attention.
  return "confirm";
}
