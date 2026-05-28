/**
 * ChannelDriver — inbound/outbound channel adapter port.
 *
 * Three responsibilities:
 *  - perceive(raw): vendor webhook -> normalized ChannelMessage
 *  - render(response): runtime response -> vendor render call
 *  - attest(envelope): sign the envelope before it enters the kernel
 *    (HMAC over `canonicalBytes(envelope)`)
 *
 * Channel adapters are also responsible for resuming long-lived sessions:
 *  - parked-confirmation matching (yes/no/defer/hash-prefix) lives in the
 *    adapter (see @claustrum/channel-whatsapp/parked-match.ts) but the
 *    `SessionPort` owns the durable state.
 */

import type { IntentEnvelope } from "@adjudicate/core";

export type ChannelKind = "whatsapp" | "web";

export interface ChannelMessage {
  readonly channel: ChannelKind;
  readonly customerId: string;
  readonly conversationId: string;
  /** Vendor-supplied identifier (Twilio MessageSid, web request id, etc.). */
  readonly externalId?: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly locale?: string;
  readonly attachments?: ReadonlyArray<{
    readonly kind: "image" | "audio" | "document";
    readonly url: string;
    readonly mimeType?: string;
  }>;
  /** Channel-specific raw payload retained for replay/debugging. */
  readonly raw?: unknown;
}

export interface RenderedResponse {
  readonly channel: ChannelKind;
  readonly customerId: string;
  readonly conversationId: string;
  /** Final text. Adapters chunk per channel rules. */
  readonly text: string;
  /** Optional structured artifacts (cards, buttons, etc.). */
  readonly artifacts?: ReadonlyArray<unknown>;
  /** Honors REQUEST_CONFIRMATION/DEFER metadata if present. */
  readonly meta?: {
    readonly awaitingConfirmation?: boolean;
    readonly deferred?: boolean;
    readonly escalated?: boolean;
    /** A dispatch port threw; the turn degraded gracefully (no crash). */
    readonly failed?: boolean;
  };
}

export interface SignedEnvelope {
  readonly envelope: IntentEnvelope;
  readonly signature: string;
  readonly keyId: string;
  readonly alg: string;
}

export interface ChannelDriver {
  readonly kind: ChannelKind;
  perceive(raw: unknown): Promise<ChannelMessage>;
  render(response: RenderedResponse): Promise<void>;
  attest(envelope: IntentEnvelope): Promise<SignedEnvelope>;
}
