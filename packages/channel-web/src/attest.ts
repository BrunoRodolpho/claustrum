/**
 * Web channel envelope attestation — shares the HMAC-SHA256 pattern with
 * the WhatsApp channel. Kept as a separate module so the two adapters
 * stay structurally independent (no cross-adapter imports — see
 * boundary discipline in CLAUDE.md).
 */

import { createHmac } from "node:crypto";
import { canonicalJson, type IntentEnvelope } from "@adjudicate/core";
import {
  resolveGatewaySigningKey,
  type GatewaySigningKey,
  type SignedEnvelope,
} from "@claustrum/core";

export interface WebAttestContext {
  readonly gateway: string;
  readonly keyId?: string;
}

export async function attestWebEnvelope(
  envelope: IntentEnvelope,
  signingKey: GatewaySigningKey,
  ctx: WebAttestContext,
): Promise<SignedEnvelope> {
  // Sign with the CURRENT key; verification accepts current OR previous via
  // verifyGatewayAttestation (AuthReviewer-010). Throws on an empty/missing key.
  const currentKey = resolveGatewaySigningKey(signingKey);
  if (!envelope || typeof envelope !== "object") {
    throw new Error("attestWebEnvelope: envelope must be an object");
  }

  const enrichedActor = {
    ...envelope.actor,
    channel: "web" as const,
    gateway: ctx.gateway,
  };
  const enriched: IntentEnvelope = {
    ...envelope,
    actor: enrichedActor as typeof envelope.actor,
  };

  const canonical = canonicalJson(enriched);
  const signature = createHmac("sha256", currentKey)
    .update(canonical, "utf8")
    .digest("hex");

  return {
    envelope: enriched,
    signature,
    keyId: ctx.keyId ?? "web-gateway-default",
    alg: "HMAC-SHA256",
  };
}
