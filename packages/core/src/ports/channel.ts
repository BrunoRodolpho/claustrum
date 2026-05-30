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

/**
 * A structured outbound artifact a channel adapter may consume alongside the
 * rendered text (cards, buttons, routing hints, etc.).
 *
 * The set of artifact shapes is open — adopters attach channel-specific
 * payloads (a button card for WhatsApp, a quick-reply list for web) and the
 * runtime stays agnostic. The runtime only *structurally* recognizes the
 * shapes it actually consumes; today that is {@link RecipientArtifact}. Typing
 * this as `ChannelArtifact` rather than `unknown` (APIReviewer-018) lets
 * consumers narrow with a typed guard ({@link isRecipientArtifact}) instead of
 * an unchecked `as { to: string }` cast that throws on a malformed artifact.
 */
export type ChannelArtifact = RecipientArtifact | Record<string, unknown>;

/**
 * Routing artifact carrying the channel-native recipient address. WhatsApp
 * needs this because the `customerId` on a `RenderedResponse` is a hashed
 * phone that cannot be un-hashed back to the E.164 `whatsapp:+...` Twilio
 * requires; the conductor passes the original address through here.
 */
export interface RecipientArtifact {
  /** Channel-native recipient address, e.g. `whatsapp:+14155238886`. */
  readonly to: string;
}

/**
 * Type guard: does `artifact` carry a usable string `to` recipient?
 * Returns a typed narrowing so consumers avoid an unchecked cast — a missing
 * or non-string `to` is a guarded `false`, never a runtime throw.
 */
export function isRecipientArtifact(
  artifact: ChannelArtifact,
): artifact is RecipientArtifact {
  return (
    typeof artifact === "object" &&
    artifact !== null &&
    "to" in artifact &&
    typeof (artifact as { to?: unknown }).to === "string"
  );
}

export interface RenderedResponse {
  readonly channel: ChannelKind;
  readonly customerId: string;
  readonly conversationId: string;
  /** Final text. Adapters chunk per channel rules. */
  readonly text: string;
  /** Optional structured artifacts (cards, buttons, recipient hints, etc.). */
  readonly artifacts?: ReadonlyArray<ChannelArtifact>;
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

  /**
   * Normalize a raw vendor webhook payload into a `ChannelMessage`.
   *
   * **Rejection contract (documented, not yet reconciled across adapters):**
   * Implementations MUST throw synchronously or return a rejected Promise
   * when the raw payload is structurally invalid or is missing fields that
   * are essential for producing a stable, routable `ChannelMessage`
   * (e.g. a missing sender identifier that the runtime needs to derive
   * `customerId` and `conversationId`).
   *
   * Fields that are missing but recoverable MAY be silently defaulted at
   * the adapter's discretion — for example, a missing `customerId` on a
   * web payload may be defaulted to `"anonymous"`.
   *
   * **Current per-adapter divergence (APIReviewer-016 / ErrorReviewer-013):**
   * - `@claustrum/channel-whatsapp` (`perceiveTwilioWebhook`): throws on
   *   missing `MessageSid` or `From` — these are non-recoverable for
   *   WhatsApp routing.
   * - `@claustrum/channel-web` (`perceiveWebPayload`): silently defaults
   *   a missing `customerId` to `"anonymous"` rather than throwing.
   *
   * This divergence is intentional per the respective channel semantics
   * but is NOT captured by the port contract today. A future task should
   * decide whether `perceive` should always throw on missing identity
   * fields, or whether the port should formally allow defaulting with an
   * explicit opt-in. Until that decision lands, callers should not assume
   * uniform rejection behavior across adapters.
   */
  perceive(raw: unknown): Promise<ChannelMessage>;
  render(response: RenderedResponse): Promise<void>;
  attest(envelope: IntentEnvelope): Promise<SignedEnvelope>;
}
