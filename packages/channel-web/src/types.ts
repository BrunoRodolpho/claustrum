/**
 * Public types for @claustrum/channel-web.
 */

import type { RenderedResponse } from "@claustrum/core";

/**
 * Pluggable render sink — the host application supplies a callback that
 * delivers the rendered response to the user (WebSocket push, SSE event,
 * HTTP long-poll resolution, etc.). The channel never owns the transport
 * itself; it just normalizes inbound and signs outbound envelopes.
 */
export type WebSink = (response: RenderedResponse) => Promise<void> | void;

export interface WebChannelConfig {
  /**
   * HMAC-SHA256 signing key used by `attest()`. Same role as the
   * Twilio-channel gateway key — distinct per gateway so a compromise
   * of one channel doesn't forge envelopes for another.
   */
  readonly gatewaySigningKey: string;
  /** Sink that delivers rendered responses to the user. */
  readonly sink: WebSink;
  /**
   * Gateway identifier (typically a hostname). Embedded in
   * `actor.gateway` for audit-side ingress tracking.
   */
  readonly gateway: string;
  /** Key id embedded in SignedEnvelope. Default `"web-gateway-default"`. */
  readonly gatewayKeyId?: string;
}

/**
 * Inbound shape — what a frontend posts to the gateway. Fields are
 * permissive on purpose: web clients have wildly different conventions
 * (mobile SDK, browser fetch, third-party widget), so the adapter
 * accepts a minimal common subset and tolerates extras.
 */
export interface WebInboundPayload {
  readonly requestId?: string;
  readonly customerId?: string;
  readonly conversationId?: string;
  readonly text?: string;
  readonly locale?: string;
  readonly receivedAt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly kind: "image" | "audio" | "document";
    readonly url: string;
    readonly mimeType?: string;
  }>;
}
