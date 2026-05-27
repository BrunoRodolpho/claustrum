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
import type { IntentEnvelope } from "@adjudicate/core";
import { attestWithGatewayKey } from "./attest.js";
import { matchToParkedByReply } from "./parked-match.js";
import { perceiveTwilioWebhook } from "./perceive.js";
import { sendTwilioMessage, splitForWhatsApp } from "./render.js";
import type {
  ParkedMatch,
  TwilioWebhookBody,
  WhatsAppChannelConfig,
} from "./types.js";

const DEFAULT_INTER_CHUNK_MS = 200;

export class WhatsAppChannel implements ChannelDriver {
  readonly kind: ChannelKind = "whatsapp";

  constructor(private readonly config: WhatsAppChannelConfig) {
    if (!config.accountSid) throw new Error("WhatsAppChannel: accountSid required");
    if (!config.authToken) throw new Error("WhatsAppChannel: authToken required");
    if (!config.twilioFrom) throw new Error("WhatsAppChannel: twilioFrom required");
    if (!config.gatewaySigningKey)
      throw new Error("WhatsAppChannel: gatewaySigningKey required");
  }

  async perceive(raw: unknown): Promise<ChannelMessage> {
    if (raw === null || typeof raw !== "object") {
      throw new Error("WhatsAppChannel.perceive: raw must be an object");
    }
    return perceiveTwilioWebhook(raw as TwilioWebhookBody);
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
    if (
      artifact &&
      typeof artifact === "object" &&
      "to" in (artifact as Record<string, unknown>) &&
      typeof (artifact as { to?: unknown }).to === "string"
    ) {
      return (artifact as { to: string }).to;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
