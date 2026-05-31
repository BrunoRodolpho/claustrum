/**
 * Gateway attestation key handling with rotation support (AuthReviewer-010).
 *
 * Channel adapters HMAC-sign every inbound IntentEnvelope with a gateway key so
 * the audit ledger can prove the envelope was minted at a trusted gateway (vs.
 * injected by a compromised LLM). A single plaintext key has no rotation hook:
 * the moment you rotate it, every envelope signed with the prior key (still in
 * flight, or recently parked awaiting a confirmation reply) fails verification.
 *
 * A `GatewayKeyProvider` carries `{ current, previous }`: signing always uses
 * `current`, while verification accepts `current` OR `previous` so a rollover
 * has a window where both are honored. A bare `string` is the non-rotating form
 * and remains fully back-compatible.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@adjudicate/core";
import type { SignedEnvelope } from "./ports/channel.js";

/**
 * Rotation-aware gateway signing key. `current` is used to sign; `previous`
 * (when present) is additionally accepted by verification during a rollover.
 */
export interface GatewayKeyProvider {
  readonly current: string;
  readonly previous?: string;
}

/** A gateway signing key: a non-rotating `string`, or a rotating provider. */
export type GatewaySigningKey = string | GatewayKeyProvider;

/**
 * Resolve the key used to SIGN — always the current key. Throws on an empty /
 * missing key (a misconfiguration that must fail loud, not sign with `""`).
 */
export function resolveGatewaySigningKey(key: GatewaySigningKey): string {
  const current = typeof key === "string" ? key : key?.current;
  if (typeof current !== "string" || current.length === 0) {
    throw new Error("resolveGatewaySigningKey: empty signing key");
  }
  return current;
}

/**
 * The candidate keys VERIFICATION accepts: current first, then previous (when
 * configured). Empty/missing entries are dropped so a `{current, previous:""}`
 * never widens acceptance to the empty key.
 */
function verificationKeys(key: GatewaySigningKey): readonly string[] {
  const candidates =
    typeof key === "string" ? [key] : [key?.current, key?.previous];
  return candidates.filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
}

function hmacHex(signingKey: string, canonical: string): string {
  return createHmac("sha256", signingKey).update(canonical, "utf8").digest("hex");
}

/** Constant-time hex-string equality; false (never throws) on length mismatch. */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Verify a `SignedEnvelope`'s gateway HMAC against a key (or `{current,
 * previous}` provider). Recomputes HMAC-SHA256 over the canonical bytes of the
 * signed (enriched) envelope — the same bytes the channel `attest()` signed —
 * and accepts a constant-time match against the current OR previous key.
 *
 * Returns `false` (never throws) for a tampered envelope, an unknown algorithm,
 * or a structurally-malformed input. Rotation-safe by construction.
 */
export function verifyGatewayAttestation(
  signed: SignedEnvelope,
  key: GatewaySigningKey,
): boolean {
  if (
    signed === null ||
    typeof signed !== "object" ||
    typeof signed.signature !== "string" ||
    signed.alg !== "HMAC-SHA256"
  ) {
    return false;
  }
  const canonical = canonicalJson(signed.envelope);
  for (const candidate of verificationKeys(key)) {
    if (constantTimeHexEqual(hmacHex(candidate, canonical), signed.signature)) {
      return true;
    }
  }
  return false;
}
