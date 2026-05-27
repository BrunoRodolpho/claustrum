/**
 * Channel-side envelope attestation.
 *
 * Every IntentEnvelope crossing into the kernel is HMAC-signed by the
 * channel adapter so the audit ledger can later prove the envelope was
 * minted at a trusted gateway (vs. injected by a compromised LLM). The
 * signature is computed over the canonical JSON serialization of the
 * envelope (the same canonical form `intentHash` is computed over),
 * which means independent re-implementations in Rust/Go can produce
 * byte-identical signatures.
 *
 * The actor field is *enriched* before signing: `actor.channel` and
 * `actor.gateway` record where the envelope entered the system. The
 * underlying `IntentActor` interface (frozen in @adjudicate/core) declares
 * `principal` + `sessionId`; the runtime extends it with optional fields
 * that downstream audit consumers can use. The kernel's `isIntentEnvelope`
 * narrowing does not reject extra fields, so this is forward-compatible.
 */

import { createHmac } from "node:crypto";
import { canonicalJson, type IntentEnvelope } from "@adjudicate/core";
import type { SignedEnvelope } from "@claustrum/core";

export interface AttestContext {
  /** Channel kind, written to `actor.channel`. */
  readonly channel: "whatsapp" | "web";
  /**
   * Gateway identifier — for WhatsApp this is the Twilio sender (e.g.
   * `whatsapp:+14155238886`); for web it's the gateway hostname. Written
   * to `actor.gateway` so downstream audit can reason about ingress.
   */
  readonly gateway: string;
  /** Key id embedded in the SignedEnvelope. Default `"gateway-default"`. */
  readonly keyId?: string;
}

/**
 * Enrich the envelope's actor with `channel`/`gateway`, then HMAC-SHA256
 * the canonical bytes of the enriched envelope with `signingKey`.
 *
 * The output `SignedEnvelope.envelope` is the enriched envelope — the
 * runtime hands this to the kernel, not the pre-enrichment one. The
 * envelope's `intentHash` is recomputed because the actor changed.
 */
export async function attestWithGatewayKey(
  envelope: IntentEnvelope,
  signingKey: string,
  ctx: AttestContext,
): Promise<SignedEnvelope> {
  if (typeof signingKey !== "string" || signingKey.length === 0) {
    throw new Error("attestWithGatewayKey: empty signing key");
  }
  if (!envelope || typeof envelope !== "object") {
    throw new Error("attestWithGatewayKey: envelope must be an object");
  }

  // Enrich the actor with channel + gateway. The original actor object is
  // immutable (frozen by buildEnvelope), so we copy and rebuild.
  const enrichedActor = {
    ...envelope.actor,
    channel: ctx.channel,
    gateway: ctx.gateway,
  };
  // The runtime keeps the envelope's existing intentHash. The actor
  // enrichment is metadata for the audit ledger — it must NOT change the
  // replay key, otherwise retries would dedupe under a different hash and
  // break the ledger contract documented in @adjudicate/core/envelope.
  // Spec ref: docs/specs/canonical-json-hash.md (intentHash is over
  // version, kind, payload, nonce, actor, taint AS CONSTRUCTED).
  //
  // Therefore: we sign the canonical bytes of the *enriched* envelope so
  // downstream verification can recompute, but the envelope.intentHash
  // field itself is preserved from construction time.
  const enriched: IntentEnvelope = {
    ...envelope,
    actor: enrichedActor as typeof envelope.actor,
  };

  const canonical = canonicalJson(enriched);
  const signature = createHmac("sha256", signingKey)
    .update(canonical, "utf8")
    .digest("hex");

  return {
    envelope: enriched,
    signature,
    keyId: ctx.keyId ?? "gateway-default",
    alg: "HMAC-SHA256",
  };
}
