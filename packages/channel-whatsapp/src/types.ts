/**
 * Public types for @claustrum/channel-whatsapp.
 */

import type { GatewaySigningKey, ParkedEnvelope } from "@claustrum/core";

export interface WhatsAppChannelConfig {
  /** Twilio account SID (`AC...`). */
  readonly accountSid: string;
  /** Twilio auth token; HMAC-SHA1 key for inbound signature verification. */
  readonly authToken: string;
  /**
   * Outbound `From` number in Twilio canonical form, e.g. `whatsapp:+14155238886`.
   */
  readonly twilioFrom: string;
  /**
   * Gateway signing key (HMAC-SHA256) used by `attest()`. Distinct from the
   * Twilio auth token — this is the runtime ↔ kernel gateway secret.
   *
   * A bare `string` is the non-rotating form. Pass `{ current, previous }`
   * (AuthReviewer-010) to rotate: `attest()` signs with `current`, while
   * `verifyGatewayAttestation()` also accepts `previous` so envelopes signed
   * just before a rollover keep verifying during the overlap window.
   */
  readonly gatewaySigningKey: GatewaySigningKey;
  /**
   * Identifier for the signing key embedded in the SignedEnvelope. Lets the
   * kernel rotate keys without breaking historical audit records.
   */
  readonly gatewayKeyId?: string;
  /**
   * Sleep between outbound message chunks (ms). Default 200 ms.
   * Twilio rate-limits aggressively at ~1 msg/sec per sender on standard
   * accounts; 200 ms keeps headroom for inbound traffic.
   */
  readonly interChunkDelayMs?: number;
  /**
   * Optional override for outbound POST. Defaults to global `fetch`. Tests
   * inject a stub; production passes nothing.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The wire shape of a Twilio inbound webhook (subset we consume).
 * Twilio posts as `application/x-www-form-urlencoded`; the adapter receives
 * the parsed body as a plain key→string map.
 *
 * Reference: https://www.twilio.com/docs/messaging/guides/webhook-request
 */
export interface TwilioWebhookBody {
  readonly MessageSid?: string;
  readonly AccountSid?: string;
  readonly From?: string;
  readonly To?: string;
  readonly Body?: string;
  readonly NumMedia?: string;
  readonly ProfileName?: string;
  readonly Latitude?: string;
  readonly Longitude?: string;
  /**
   * `MediaUrl0` … `MediaUrl9` and `MediaContentType0` … are also present
   * when the inbound message carries media. Indexed access keeps the type
   * minimal; perceive() walks `NumMedia`.
   */
  readonly [key: string]: string | undefined;
}

/**
 * The full inbound request the webhook route forwards to the channel adapter.
 * RC-R2 / Decision 2: the channel adapter OWNS Twilio signature verification,
 * so it needs the request URL + `X-Twilio-Signature` header in addition to the
 * parsed body. The route stays thin: parse the form body, capture the URL and
 * the signature header, hand all three here.
 */
export interface TwilioInboundRequest {
  /** Full URL Twilio POSTed to, including query string (use X-Original-URL behind a proxy). */
  readonly url: string;
  /** The `X-Twilio-Signature` request header. */
  readonly signature: string;
  /** Parsed `application/x-www-form-urlencoded` body. */
  readonly body: TwilioWebhookBody;
}

/**
 * Result of `matchToParkedByReply` — augments the parked envelope with a
 * resolution intent derived from the user reply.
 */
export type UserResolution = "confirm" | "deny" | "defer";

export interface ParkedMatch {
  readonly parked: ParkedEnvelope;
  readonly userResolution: UserResolution;
  /**
   * When `userResolution === "defer"`, the natural-language phrase that
   * triggered the defer. The conductor maps this to a concrete `deferUntil`
   * (channel adapter doesn't own clock math beyond detection).
   */
  readonly deferPhrase?: string;
}
