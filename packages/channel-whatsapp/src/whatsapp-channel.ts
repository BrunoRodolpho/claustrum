/**
 * WhatsAppChannel — Twilio WhatsApp `ChannelDriver` implementation.
 *
 * Composes perceive/render/attest/parked-match into the port shape declared
 * by @claustrum/core. The class itself is stateless: configuration is
 * passed at construction, every method is a thin orchestration over a
 * pure helper. Long-lived state lives in `SessionPort`, not here.
 *
 * NOTE on Twilio SDK: this implementation talks to Twilio's REST API via
 * `fetch` directly with Basic auth (account SID + auth token). The npm
 * `twilio` package is declared as a dependency so adopters who prefer the
 * typed SDK can wire it in, but the adapter itself doesn't import it —
 * keeping the dependency optional at runtime and letting tests inject a
 * `fetch` stub without monkey-patching the SDK. The choice was made
 * because the SDK pulls a large transitive graph for surface area we
 * don't use; see `render.ts` for the wire format.
 */

import type {
  ChannelDriver,
  ChannelKind,
  ChannelMessage,
  RenderedResponse,
  Session,
  SignedEnvelope,
} from "@claustrum/core";
import { isRecipientArtifact, resolveGatewaySigningKey } from "@claustrum/core";
import type { IntentEnvelope } from "@adjudicate/core";
import { attestWithGatewayKey } from "./attest.js";
import { matchToParkedByReply } from "./parked-match.js";
import { perceiveTwilioWebhook } from "./perceive.js";
import { sendTwilioMessage, splitForWhatsApp } from "./render.js";
import { verifyTwilioSignature } from "./twilio-signature.js";
import type {
  ParkedMatch,
  TwilioInboundRequest,
  WhatsAppChannelConfig,
} from "./types.js";

/** Thrown when an inbound webhook fails Twilio signature verification. The webhook route maps this to HTTP 403. */
export class TwilioVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwilioVerificationError";
  }
}

const DEFAULT_INTER_CHUNK_MS = 200;

export class WhatsAppChannel implements ChannelDriver {
  readonly kind: ChannelKind = "whatsapp";

  constructor(private readonly config: WhatsAppChannelConfig) {
    if (!config.accountSid) throw new Error("WhatsAppChannel: accountSid required");
    if (!config.authToken) throw new Error("WhatsAppChannel: authToken required");
    if (!config.twilioFrom) throw new Error("WhatsAppChannel: twilioFrom required");
    // Resolve to validate: catches both a missing key and a `{current:""}`
    // provider that the old truthy-check on the object would have let through.
    try {
      resolveGatewaySigningKey(config.gatewaySigningKey);
    } catch {
      throw new Error("WhatsAppChannel: gatewaySigningKey required");
    }
  }

  /**
   * Verify the inbound Twilio signature, THEN normalize to a ChannelMessage.
   *
   * RC-R2 / Decision 2: verification is mandatory and fail-closed. `raw` MUST
   * be a {@link TwilioInboundRequest} (url + X-Twilio-Signature + parsed body)
   * forwarded by the thin webhook route. Without that context — or with a
   * signature that does not match an HMAC-SHA1 over the canonical Twilio string
   * keyed by the account auth token — the request is rejected with
   * {@link TwilioVerificationError} and never normalized-and-adjudicated. This
   * is the only thing standing between "any party that can POST a webhook" and
   * a kernel-adjudicated mutation.
   */
  async perceive(raw: unknown): Promise<ChannelMessage> {
    if (raw === null || typeof raw !== "object") {
      throw new TwilioVerificationError(
        "WhatsAppChannel.perceive: raw must be a TwilioInboundRequest { url, signature, body }",
      );
    }
    const req = raw as Partial<TwilioInboundRequest>;
    if (
      typeof req.url !== "string" ||
      typeof req.signature !== "string" ||
      req.body === null ||
      typeof req.body !== "object"
    ) {
      throw new TwilioVerificationError(
        "WhatsAppChannel.perceive: missing verification context (url, signature, body); forward the raw Twilio request from the webhook route",
      );
    }
    const verified = verifyTwilioSignature({
      authToken: this.config.authToken,
      signature: req.signature,
      url: req.url,
      params: req.body,
    });
    if (!verified) {
      throw new TwilioVerificationError(
        "WhatsAppChannel.perceive: Twilio signature verification failed",
      );
    }
    return perceiveTwilioWebhook(req.body);
  }

  async render(response: RenderedResponse): Promise<void> {
    const chunks = splitForWhatsApp(response.text);
    if (chunks.length === 0) return;

    // The customerId on RenderedResponse is the hashed phone — we cannot
    // un-hash it to recover the E.164 number Twilio needs. The caller (the
    // conductor) is responsible for retaining the original `whatsapp:+...`
    // address on the conversation context and passing it in via the
    // `artifacts` channel. If the convention isn't followed we surface a
    // clear error rather than silently dropping the message.
    const to = extractRecipient(response);
    if (!to) {
      throw new Error(
        "WhatsAppChannel.render: no `to` recipient available; pass `{ to: 'whatsapp:+...' }` in response.artifacts",
      );
    }

    const delay = this.config.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_MS;
    for (let i = 0; i < chunks.length; i++) {
      await sendTwilioMessage({
        accountSid: this.config.accountSid,
        authToken: this.config.authToken,
        from: this.config.twilioFrom,
        to,
        body: chunks[i],
        ...(this.config.fetch !== undefined ? { fetch: this.config.fetch } : {}),
      });
      if (i < chunks.length - 1) {
        await sleep(delay);
      }
    }
  }

  async attest(envelope: IntentEnvelope): Promise<SignedEnvelope> {
    return attestWithGatewayKey(envelope, this.config.gatewaySigningKey, {
      channel: "whatsapp",
      gateway: this.config.twilioFrom,
      ...(this.config.gatewayKeyId !== undefined
        ? { keyId: this.config.gatewayKeyId }
        : {}),
    });
  }

  /**
   * Resolve an inbound ChannelMessage against the session's parked
   * envelopes. Returns null when the reply is a fresh utterance; a
   * `ParkedMatch` when the reply resumes a parked confirmation.
   *
   * Channel-side ownership of this match (rather than putting it in the
   * conductor) is the load-bearing design choice: matching is a
   * channel-shaped concern (regex against natural language, hash-prefix
   * conventions, locale variants). The conductor consumes the result and
   * issues a re-adjudication.
   */
  matchToParked(channelEvent: ChannelMessage, session: Session): ParkedMatch | null {
    return matchToParkedByReply(channelEvent.text, session);
  }
}

function extractRecipient(response: RenderedResponse): string | null {
  if (!response.artifacts) return null;
  for (const artifact of response.artifacts) {
    // Typed narrowing (APIReviewer-018): `isRecipientArtifact` proves the
    // `to: string` shape, so `artifact.to` is a checked access — a missing or
    // non-string `to` is a guarded skip, never an unchecked cast that throws.
    if (isRecipientArtifact(artifact)) {
      return artifact.to;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
